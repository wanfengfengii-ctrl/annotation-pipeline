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
