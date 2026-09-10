import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOLO_CREDENTIAL, main } from '../scripts/solo-keychain.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

test('public credential identity is fixed and contains no password', () => {
  assert.deepEqual(SOLO_CREDENTIAL, {
    service: 'annotation-pipeline.solo',
    username: 'niuyuhang',
    origin: 'https://solo2.jzxhnh.com',
  });
  assert.equal(Object.isFrozen(SOLO_CREDENTIAL), true);
});

test('the public CLI never exposes the private read command', async () => {
  await assert.rejects(main('--read-for-login'), /用法/);
});

test('save rejects noninteractive callers without compiling or accessing Keychain', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/solo-keychain.mjs', '--save'],
    {
      cwd: project,
      input: 'not-a-real-password\n',
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /本机交互终端/);
  assert.doesNotMatch(result.stdout + result.stderr, /not-a-real-password/);
});

test('unexpected command arguments are rejected without echoing them', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/solo-keychain.mjs', '--save', 'fixture-sensitive-argument'],
    {
      cwd: project,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不接受密码参数/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /fixture-sensitive-argument/,
  );
});

test(
  'native helper compiles and enforces its nonsecret contract before Keychain access',
  {
    skip: process.platform !== 'darwin',
    timeout: 120000,
  },
  () => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), 'solo-keychain-test-'),
    );
    const helper = path.join(temporary, 'solo-keychain');
    try {
      const build = spawnSync(
        '/usr/bin/xcrun',
        [
          'swiftc',
          path.join(project, 'scripts/solo-keychain.swift'),
          '-o',
          helper,
        ],
        {
          encoding: 'utf8',
          timeout: 110000,
        },
      );
      assert.equal(build.status, 0, build.stderr);
      const contract = spawnSync(helper, ['--contract'], { encoding: 'utf8' });
      assert.equal(contract.status, 0);
      assert.deepEqual(JSON.parse(contract.stdout), {
        service: SOLO_CREDENTIAL.service,
        account: SOLO_CREDENTIAL.username,
        origin: SOLO_CREDENTIAL.origin,
        secretChannel: 'inherited-pipe-3',
      });
      const save = spawnSync(helper, ['--save'], {
        input: 'not-a-real-password\n',
        encoding: 'utf8',
      });
      assert.equal(save.status, 1);
      assert.equal(
        JSON.parse(save.stderr).error,
        'interactive_terminal_required',
      );
      assert.equal(save.stdout, '');
      assert.doesNotMatch(save.stderr, /not-a-real-password/);

      const noChannel = spawnSync(helper, ['--read-for-login'], {
        encoding: 'utf8',
      });
      assert.equal(noChannel.status, 1);
      assert.equal(
        JSON.parse(noChannel.stderr).error,
        'private_channel_required',
      );
      assert.equal(noChannel.stdout, '');

      // A regular output file must fail before any credential query. The actual
      // file remains empty; no status/read/save operation hits a real Keychain.
      const file = path.join(temporary, 'forbidden-output');
      const fd = fs.openSync(file, 'w', 0o600);
      try {
        const regularFile = spawnSync(helper, ['--read-for-login'], {
          stdio: ['ignore', 'pipe', 'pipe', fd],
          encoding: 'utf8',
        });
        assert.equal(regularFile.status, 1);
        assert.equal(
          JSON.parse(regularFile.stderr).error,
          'private_channel_required',
        );
        assert.equal(fs.statSync(file).size, 0);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
);
