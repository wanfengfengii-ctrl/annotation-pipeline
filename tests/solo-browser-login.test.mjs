import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { SOLO_CREDENTIAL } from '../scripts/solo-keychain.mjs';
import { submitSoloLogin } from '../scripts/solo-browser-login.mjs';

function fixture() {
  const secret = 'fixture-only-sensitive-password';
  const password = Buffer.from(secret);
  const calls = [];
  const state = {
    url: SOLO_CREDENTIAL.origin + '/login',
    reads: 0,
    clicks: 0,
  };
  function locator(name) {
    return {
      count: async () => 1,
      isVisible: async () => true,
      getAttribute: async (attribute) => {
        assert.equal(attribute, 'type');
        return name === 'password' ? 'password' : 'text';
      },
      isEnabled: async () => true,
      fill: async (value) => {
        calls.push(name + ':fill');
        assert.equal(
          value,
          name === 'password' ? secret : SOLO_CREDENTIAL.username,
        );
      },
      click: async () => {
        calls.push(name + ':click');
        state.clicks++;
      },
    };
  }
  const form = {
    tab: { url: async () => state.url },
    usernameField: locator('username'),
    passwordField: locator('password'),
    submitButton: locator('submit'),
  };
  const credentialReader = async (consume) => {
    state.reads++;
    return consume({ ...SOLO_CREDENTIAL, password });
  };
  return { secret, password, calls, state, form, credentialReader };
}

function run(f) {
  return submitSoloLogin(f.form, { credentialReader: f.credentialReader });
}

test('one login attempt fills once, clicks once, clears the Buffer and requires verification', async () => {
  const f = fixture();
  const result = await run(f);
  assert.deepEqual(result, {
    status: 'verification_required',
    origin: SOLO_CREDENTIAL.origin,
    username: SOLO_CREDENTIAL.username,
    submitted: true,
  });
  assert.deepEqual(f.calls, ['username:fill', 'password:fill', 'submit:click']);
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.clicks, 1);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.secret));
});

test('wrong origins and URL credentials are rejected before credential access', async () => {
  for (const url of [
    'http://solo2.jzxhnh.com/login',
    'https://solo2.jzxhnh.com.evil.example/login',
    'https://solo2.jzxhnh.com:444/login',
    'https://niuyuhang:private@solo2.jzxhnh.com/login',
    'https://niuyuhang@solo2.jzxhnh.com/login',
    'about:blank',
    'invalid-url',
  ]) {
    const f = fixture();
    f.state.url = url;
    await assert.rejects(run(f), { code: /login_origin_/ });
    assert.equal(f.state.reads, 0);
    assert.deepEqual(f.calls, []);
  }
});

test('unverified controls never trigger a credential read', async () => {
  const variants = [
    (f) => {
      f.form.passwordField.getAttribute = async () => 'text';
    },
    (f) => {
      f.form.passwordField.getAttribute = async () => null;
    },
    (f) => {
      f.form.usernameField.count = async () => 2;
    },
    (f) => {
      f.form.passwordField.count = async () => 0;
    },
    (f) => {
      f.form.submitButton.isVisible = async () => false;
    },
  ];
  for (const change of variants) {
    const f = fixture();
    change(f);
    await assert.rejects(run(f), {
      code: /login_(password_field_invalid|controls_unverified)/,
    });
    assert.equal(f.state.reads, 0);
    assert.deepEqual(f.calls, []);
  }
});

test('initially disabled submit can become enabled after both fields are filled', async () => {
  const f = fixture();
  f.form.submitButton.isEnabled = async () =>
    f.calls.includes('username:fill') && f.calls.includes('password:fill');
  assert.equal(await f.form.submitButton.isEnabled(), false);
  const result = await run(f);
  assert.equal(result.status, 'verification_required');
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.clicks, 1);
  assert.deepEqual(f.calls, ['username:fill', 'password:fill', 'submit:click']);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('submit that stays disabled is never clicked and the password buffer is cleared', async () => {
  const f = fixture();
  f.form.submitButton.isEnabled = async () => false;
  await assert.rejects(run(f), { code: 'login_submit_disabled' });
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.clicks, 0);
  assert.deepEqual(f.calls, ['username:fill', 'password:fill']);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('navigation while credentials are being read prevents both fills and cleans the Buffer', async () => {
  const f = fixture();
  f.credentialReader = async (consume) => {
    f.state.url = 'https://other.example/login';
    return consume({ ...SOLO_CREDENTIAL, password: f.password });
  };
  await assert.rejects(run(f), { code: 'login_origin_mismatch' });
  assert.deepEqual(f.calls, []);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('navigation after username fill prevents password fill', async () => {
  const f = fixture();
  f.form.usernameField.fill = async () => {
    f.calls.push('username:fill');
    f.state.url = 'https://other.example/login';
  };
  await assert.rejects(run(f), { code: 'login_origin_mismatch' });
  assert.deepEqual(f.calls, ['username:fill']);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('navigation or field type change after password fill prevents submit', async () => {
  for (const changedOrigin of [true, false]) {
    const f = fixture();
    f.form.passwordField.fill = async () => {
      f.calls.push('password:fill');
      if (changedOrigin) f.state.url = 'https://other.example/login';
      else f.form.passwordField.getAttribute = async () => 'text';
    };
    await assert.rejects(run(f), {
      code: changedOrigin
        ? 'login_origin_mismatch'
        : 'login_password_field_invalid',
    });
    assert.equal(f.state.clicks, 0);
    assert.equal(
      f.password.every((byte) => byte === 0),
      true,
    );
  }
});

test('locator failure never exposes its password-bearing error or retries', async () => {
  const f = fixture();
  f.form.passwordField.fill = async (value) => {
    f.calls.push('password:fill');
    const error = new Error('fill failed: ' + value);
    error.secret = value;
    throw error;
  };
  await assert.rejects(run(f), (error) => {
    assert.equal(error.code, 'login_action_failed');
    assert.doesNotMatch(
      error.stack + JSON.stringify(error),
      new RegExp(f.secret),
    );
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(f.calls, ['username:fill', 'password:fill']);
  assert.equal(f.state.clicks, 0);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('click failure is uncertain, does not retry and is sanitized', async () => {
  const f = fixture();
  f.form.submitButton.click = async () => {
    f.state.clicks++;
    throw new Error('page failure with ' + f.secret);
  };
  await assert.rejects(run(f), (error) => {
    assert.equal(error.code, 'login_submission_uncertain');
    assert.doesNotMatch(error.stack, new RegExp(f.secret));
    return true;
  });
  assert.equal(f.state.clicks, 1);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('credential errors expose only allowlisted codes', async () => {
  for (const code of [
    'credential_missing',
    'keychain_locked_or_denied',
    'a-secret-code',
  ]) {
    const f = fixture();
    f.credentialReader = async () => {
      throw Object.assign(new Error(f.secret), { code });
    };
    await assert.rejects(run(f), (error) => {
      assert.equal(
        error.code,
        code === 'a-secret-code' ? 'credential_unavailable' : code,
      );
      assert.doesNotMatch(
        error.stack + JSON.stringify(error),
        /a-secret-code|fixture-only-sensitive-password/,
      );
      return true;
    });
    assert.deepEqual(f.calls, []);
  }
});

test('credential identity mismatch is rejected and its buffer erased', async () => {
  const f = fixture();
  f.credentialReader = (consume) =>
    consume({
      ...SOLO_CREDENTIAL,
      username: 'someone-else',
      password: f.password,
    });
  await assert.rejects(run(f), { code: 'invalid_credential' });
  assert.deepEqual(f.calls, []);
  assert.equal(
    f.password.every((byte) => byte === 0),
    true,
  );
});

test('a reader cannot repeat the callback or inject a returned secret', async () => {
  const f = fixture();
  const second = Buffer.from(f.secret);
  f.credentialReader = async (consume) => {
    await consume({ ...SOLO_CREDENTIAL, password: f.password });
    return consume({ ...SOLO_CREDENTIAL, password: second });
  };
  await assert.rejects(run(f), { code: 'login_submission_uncertain' });
  assert.equal(f.state.clicks, 1);
  assert.equal(
    second.every((byte) => byte === 0),
    true,
  );

  const g = fixture();
  g.credentialReader = async (consume) => ({
    ...(await consume({ ...SOLO_CREDENTIAL, password: g.password })),
    unexpected: g.secret,
  });
  assert.equal(JSON.stringify(await run(g)).includes(g.secret), false);
});

test('missing adapter methods or callback cannot be treated as submitted', async () => {
  const f = fixture();
  f.form.passwordField.getAttribute = undefined;
  await assert.rejects(run(f), { code: 'login_adapter_invalid' });
  assert.equal(f.state.reads, 0);
  const g = fixture();
  g.credentialReader = async () => ({
    status: 'verification_required',
    submitted: true,
  });
  await assert.rejects(run(g), { code: 'credential_reader_invalid' });
  assert.equal(g.state.clicks, 0);
});
