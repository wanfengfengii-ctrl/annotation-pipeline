import test from 'node:test';
import assert from 'node:assert/strict';
import { publishContainerState } from '../scripts/container-publication.mjs';
import { createRunnerApi } from '../scripts/runner-api.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';

test('reattaching a saved completed result never reserves or sends the original prompt again', async () => {
  const result = {
    success: true,
    executionOutcome: 'complete',
    promptId: 'native-prompt',
    sessionId: 'native-session',
  };
  const state = { taskId: 'task', results: { round: result } };
  const runtime = {
    ensure: async () => state,
    public: DockerRuntime.prototype.public,
  };
  const restored = await DockerRuntime.prototype.execute.call(
    runtime,
    { id: 'task' },
    { id: 'round', prompt: '原题' },
    async () =>
      assert.fail('the saved result must not reserve another Claude call'),
  );
  assert.deepEqual(restored, { ...result, container: { taskId: 'task' } });
  assert.deepEqual(state.results.round, result);
});

test('a completed Claude result survives a transient container callback without replaying execution', async () => {
  const body = { taskId: 'fixture', questionId: 'round', status: 'running' };
  for (const status of [502, 503, 504]) {
    const calls = [],
      delays = [];
    const api = createRunnerApi({
      base: 'http://localhost:3001',
      token: 'fixture-only',
      request: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return calls.length < 3
          ? new Response('worker restarted', { status })
          : Response.json({ ok: true });
      },
      pause: async () =>
        assert.fail('retry belongs to the job publication boundary'),
    });
    assert.deepEqual(
      await publishContainerState(
        (container) =>
          api({ action: 'container', taskId: container.taskId, container }),
        body,
        async (delay) => delays.push(delay),
      ),
      { ok: true },
    );
    assert.deepEqual(delays, [250, 500]);
    assert.deepEqual(
      calls,
      Array(3).fill({
        action: 'container',
        taskId: 'fixture',
        container: body,
      }),
    );
  }
});

test('disconnected publication uses a frozen payload and a bounded retry budget', async () => {
  const state = { taskId: 'fixture', progress: { level: 'done' } };
  const seen = [];
  await assert.rejects(
    publishContainerState(
      async (value) => {
        seen.push(structuredClone(value));
        value.progress.level = 'changed';
        state.progress.level = 'also changed';
        throw new Error('执行器接口 container：fetch failed', {
          cause: new TypeError('fetch failed'),
        });
      },
      state,
      async () => {},
    ),
    /fetch failed/,
  );
  assert.deepEqual(
    seen,
    Array(3).fill({ taskId: 'fixture', progress: { level: 'done' } }),
  );
});

test('publication does not retry business errors, permission failures or unrelated actions', async () => {
  for (const message of [
    '执行器接口 container：数据已更新，请刷新后重试',
    '执行器接口 container：HTTP 401，响应不是有效的 JSON',
    '执行器接口 container：HTTP 200，响应不是有效的 JSON',
    '执行器接口 finish：HTTP 503，响应不是有效的 JSON',
    'permission denied',
  ]) {
    let calls = 0;
    await assert.rejects(
      publishContainerState(
        async () => {
          calls++;
          throw new Error(message);
        },
        {},
        async () => assert.fail('no retry'),
      ),
      { message },
    );
    assert.equal(calls, 1);
  }
});
