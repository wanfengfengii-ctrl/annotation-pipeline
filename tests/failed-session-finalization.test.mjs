import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DockerRuntime,
  assertNativeSessionIdle,
} from '../scripts/docker-runtime.mjs';
import { assertFailedSessionCandidate } from '../scripts/finalize-failed-session.mjs';
import { terminalProtocolVersion } from '../scripts/mac-terminal.mjs';

function fixture() {
  const first = {
    id: 'first',
    questionRootId: 'first',
    status: 'review',
    review: {},
    automation: { archive: {} },
  };
  const turn = {
    id: 'failed',
    questionRootId: 'first',
    status: 'failed',
    executionOutcome: 'error',
    sessionId: 'session',
    promptId: 'prompt',
    container: { containerId: 'container' },
  };
  const result = {
    success: false,
    executionOutcome: 'error',
    promptId: 'prompt',
    sessionId: 'session',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
  };
  const task = { id: 'task', turns: [first, turn] };
  const state = {
    taskId: 'task',
    questionId: 'first',
    status: 'running',
    containerId: 'container',
    sessionId: 'session',
    results: { failed: result },
    terminal: { terminalProtocolVersion, runId: 'run' },
  };
  const events = [
    {
      type: 'user',
      uuid: 'prompt',
      sessionId: 'session',
      message: { content: 'repair' },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'pending' }] },
    },
    {
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'API response stopped' }] },
    },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const files = () => [
    { content: events.map((e) => JSON.stringify(e)).join('\n') + '\n' },
  ];
  return { task, state, result, turn, events, files };
}

test('explicit completed error may finalize; default still holds and failure remains unchanged', () => {
  const f = fixture(),
    before = structuredClone(f.state);
  assert.throws(() => assertNativeSessionIdle(f.state, f.files()), /成功回执/);
  assert.equal(
    assertFailedSessionCandidate(f.task, f.state, 'failed', f.files()).promptId,
    'prompt',
  );
  assert.deepEqual(f.state, before);
  assert.equal(f.result.success, false);
});

test('completed permission failure can archive unchanged only after every tool has returned', () => {
  const f = fixture();
  f.result.permissionAudit.passed = false;
  f.result.executionOutcome = 'complete';
  f.events[1].message.content = [
    { type: 'tool_use', id: 'tool', name: 'Bash' },
  ];
  f.events[2] = {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool',
          is_error: true,
          content: 'Permission denied',
        },
      ],
    },
  };
  const before = f.files()[0].content;
  assert.throws(() => assertNativeSessionIdle(f.state, f.files()));
  assert.equal(
    assertNativeSessionIdle(f.state, f.files(), { failedTurnId: 'failed' })
      .completedPromptIds[0],
    'prompt',
  );
  assert.equal(f.files()[0].content, before);
  assert.equal(f.result.success, false);
  f.events[2].message.content[0].tool_use_id = 'different';
  assert.throws(() =>
    assertNativeSessionIdle(f.state, f.files(), { failedTurnId: 'failed' }),
  );
});

test('pending, partial, later activity, tools, wrong error, missing archive or wrong identity are held', () => {
  const changes = [
    (f) => {
      f.state.pending = { phase: 'sent' };
    },
    (f) => {
      f.events.pop();
    },
    (f) => {
      f.events.push({ type: 'assistant', message: { content: [] } });
    },
    (f) => {
      f.events[1].message.content = [{ type: 'tool_use', name: 'Bash' }];
    },
    (f) => {
      f.events[1] = {
        type: 'user',
        message: { content: [{ type: 'tool_result' }] },
      };
    },
    (f) => {
      f.events[2].error = 'authentication_error';
    },
    (f) => {
      f.result.traceExport.verified = false;
    },
    (f) => {
      f.result.permissionAudit.passed = false;
    },
    (f) => {
      f.result.promptId = 'other';
    },
    (f) => {
      f.state.containerId = 'other';
    },
    (f) => {
      f.turn.status = 'running';
    },
    (f) => {
      f.task.turns[0].status = 'queued';
    },
    (f) => {
      f.state.terminal.terminalProtocolVersion = 'legacy';
    },
    (f) => {
      f.task.turns[0].automation.archive = null;
    },
  ];
  for (const mutate of changes) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      assertFailedSessionCandidate(f.task, f.state, 'failed', f.files()),
    );
  }
});

test('explicit failed turn must be the actual last native prompt, not an old result', () => {
  const f = fixture();
  f.events.push(
    {
      type: 'user',
      uuid: 'later',
      sessionId: 'session',
      message: { content: 'new input' },
    },
    { type: 'system', subtype: 'turn_duration' },
  );
  f.state.results.later = {
    success: true,
    promptId: 'later',
    sessionId: 'session',
    traceExport: { verified: true },
  };
  assert.throws(
    () => assertFailedSessionCandidate(f.task, f.state, 'failed', f.files()),
    /原生末轮/,
  );
});

test('a new result during terminal attachment prevents input and is never overwritten', async () => {
  const f = fixture(),
    runtime = Object.create(DockerRuntime.prototype);
  let writes = 0,
    saved = 0;
  runtime.load = () => structuredClone(f.state);
  runtime.owned = () => ({ State: { Running: true } });
  runtime.native = () => f.files();
  runtime.live = new Map([
    [
      'task',
      {
        child: {
          stdin: {
            write: () => {
              writes++;
            },
          },
        },
      },
    ],
  ]);
  runtime.attach = async () => {
    f.state.results.later = { success: true, promptId: 'later' };
  };
  runtime.save = () => {
    saved++;
  };
  runtime.report = async () => {};
  await assert.rejects(
    runtime.close('task', { failedTurnId: 'failed' }),
    /回执已变化/,
  );
  assert.equal(writes, 0);
  assert.equal(saved, 0);
  assert.equal(f.state.results.later.success, true);
});

test('asynchronous API guard runs before connecting or sending terminal input', async () => {
  const f = fixture(),
    runtime = Object.create(DockerRuntime.prototype);
  let attached = false;
  runtime.load = () => structuredClone(f.state);
  runtime.owned = () => ({ State: { Running: true } });
  runtime.native = () => f.files();
  runtime.attach = async () => {
    attached = true;
  };
  runtime.save = () => {};
  runtime.report = async () => {};
  await assert.rejects(
    runtime.close('task', {
      failedTurnId: 'failed',
      beforeExit: async () => {
        await Promise.resolve();
        throw Error('API revision changed');
      },
    }),
    /API revision changed/,
  );
  assert.equal(attached, false);
});
