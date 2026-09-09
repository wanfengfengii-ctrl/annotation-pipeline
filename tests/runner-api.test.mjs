import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerApi } from '../scripts/runner-api.mjs';

const disconnected = () =>
  new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
const setup = (request, pause = async () => {}) =>
  createRunnerApi({
    base: 'http://localhost:3001',
    token: 'fixture-only',
    request,
    pause,
  });

test('Retries transient disconnects only for repeatable keyed updates and reads', async () => {
  for (const action of [
    'heartbeat',
    'supply-context',
    'stage',
    'initial-code-snapshot',
  ]) {
    const calls = [],
      delays = [];
    const body = {
      action,
      taskId: 'task',
      questionId: 'question',
      stage: 'claude',
    };
    const api = setup(
      async (url, options) => {
        calls.push({ url, body: options.body, signal: options.signal });
        if (calls.length < 3) throw disconnected();
        return Response.json({ ok: true });
      },
      async (delay) => delays.push(delay),
    );
    assert.deepEqual(await api(body), { ok: true });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.body === JSON.stringify(body)));
    assert.equal(new Set(calls.map((c) => c.signal)).size, 3);
    assert.deepEqual(delays, [250, 500]);
  }
});

test('Uncertain claims, Claude reservations, enqueue and completion are never repeated', async () => {
  for (const action of [
    'claim',
    'reserve-claude',
    'enqueue-auto',
    'finish',
    'unknown-action',
  ]) {
    let calls = 0;
    const api = setup(async () => {
      calls++;
      throw disconnected();
    });
    await assert.rejects(
      api({ action }),
      new RegExp(action + '.*UND_ERR_SOCKET'),
    );
    assert.equal(calls, 1);
  }
});

test('Retries stop after three attempts and do not repeat server or invalid JSON responses', async () => {
  let calls = 0;
  await assert.rejects(
    setup(async () => {
      calls++;
      throw disconnected();
    })({ action: 'stage' }),
    /stage.*UND_ERR_SOCKET/,
  );
  assert.equal(calls, 3);
  for (const response of [
    () => Response.json({ error: 'stale job token' }, { status: 409 }),
    () => new Response('invalid JSON'),
  ]) {
    calls = 0;
    await assert.rejects(
      setup(async () => {
        calls++;
        return response();
      })({ action: 'stage' }),
    );
    assert.equal(calls, 1);
  }
});

test('An interrupted response body can be recovered for a repeatable update', async () => {
  let calls = 0;
  const api = setup(async () => {
    calls++;
    if (calls === 1)
      return {
        ok: true,
        json: async () => {
          throw new TypeError('terminated');
        },
      };
    return Response.json({ duplicate: true });
  });
  assert.deepEqual(await api({ action: 'initial-code-snapshot' }), {
    duplicate: true,
  });
  assert.equal(calls, 2);
});

test('Repeatable actions recover from gateway text responses with bounded backoff', async () => {
  for (const action of [
    'heartbeat',
    'supply-context',
    'stage',
    'initial-code-snapshot',
  ]) {
    for (const status of [502, 503, 504]) {
      const calls = [],
        delays = [];
      const body = { action, taskId: 'task', stage: 'runtime-plan' };
      const api = setup(
        async (_url, options) => {
          calls.push(options.body);
          return calls.length < 3
            ? new Response('Your worker restarted mid-request', { status })
            : Response.json({ ok: true });
        },
        async (delay) => delays.push(delay),
      );
      assert.deepEqual(await api(body), { ok: true });
      assert.deepEqual(calls, Array(3).fill(JSON.stringify(body)));
      assert.deepEqual(delays, [250, 500]);
    }
  }
});

test('Gateway retries stop after three attempts without exposing response text', async () => {
  let calls = 0;
  const delays = [];
  const sensitiveText =
    'Your worker restarted mid-request secret-fixture-token';
  const api = setup(
    async () => {
      calls++;
      return new Response(sensitiveText, { status: 503 });
    },
    async (delay) => delays.push(delay),
  );
  await assert.rejects(api({ action: 'heartbeat' }), (error) => {
    assert.match(error.message, /heartbeat.*HTTP 503.*JSON/);
    assert.equal(error.cause, undefined);
    assert.ok(!error.stack.includes(sensitiveText));
    assert.ok(!error.stack.includes('secret-fixture-token'));
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('Gateway statuses never replay uncertain non-repeatable actions', async () => {
  for (const action of [
    'claim',
    'reserve-claude',
    'enqueue-auto',
    'finish',
    'unknown-action',
  ]) {
    for (const status of [502, 503, 504]) {
      for (const response of [
        () => new Response('Your worker restarted mid-request', { status }),
        () => Response.json({}, { status }),
      ]) {
        let calls = 0;
        const api = setup(
          async () => {
            calls++;
            return response();
          },
          async () => assert.fail('non-repeatable action must not back off'),
        );
        await assert.rejects(api({ action }), new RegExp(`HTTP ${status}`));
        assert.equal(calls, 1);
      }
    }
  }
});

test('JSON business errors keep their meaning without retries, even on gateway statuses', async () => {
  for (const status of [400, 409, 500, 502, 503, 504]) {
    let calls = 0;
    const api = setup(
      async () => {
        calls++;
        return Response.json({ error: 'stale job token' }, { status });
      },
      async () => assert.fail('business errors must not back off'),
    );
    await assert.rejects(api({ action: 'stage' }), {
      message: '执行器接口 stage：stale job token',
    });
    assert.equal(calls, 1);
  }
});

test('Malformed successful JSON and other HTTP failures are explicit and not retried', async () => {
  for (const status of [200, 400, 401, 409, 500]) {
    let calls = 0;
    const api = setup(
      async () => {
        calls++;
        return new Response('private-fixture-response', { status });
      },
      async () => assert.fail('non-transient responses must not back off'),
    );
    await assert.rejects(api({ action: 'heartbeat' }), (error) => {
      assert.match(
        error.message,
        new RegExp(`heartbeat.*HTTP ${status}.*JSON`),
      );
      assert.ok(!error.stack.includes('private-fixture-response'));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Gateway responses without application errors share the same retry budget as disconnects', async () => {
  let calls = 0;
  const delays = [];
  const api = setup(
    async () => {
      calls++;
      if (calls === 1) throw disconnected();
      return Response.json(null, { status: 503 });
    },
    async (delay) => delays.push(delay),
  );
  await assert.rejects(
    api({ action: 'supply-context' }),
    /supply-context.*HTTP 503/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});
