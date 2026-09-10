import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as flush } from 'node:timers/promises';
import { NativeProgressWatch } from '../scripts/native-progress.mjs';
import { DockerRuntime, readNativeTurn } from '../scripts/docker-runtime.mjs';

const user = {
  type: 'user',
  uuid: 'prompt',
  sessionId: 'session',
  message: { content: 'task' },
};
const activity = (uuid, type = 'tool_use') => ({
  type: 'assistant',
  uuid,
  sessionId: 'session',
  message: {
    content: [
      { type, name: 'Read', id: uuid, text: 'working', thinking: 'working' },
    ],
  },
});
const files = (events, partial = '') => [
  {
    name: 'session.jsonl',
    content:
      [user, ...events].map((e) => JSON.stringify(e)).join('\n') +
      '\n' +
      partial,
  },
];
const native = (events, partial) =>
  readNativeTurn(files(events, partial), 'task');

test('current native work extends observation beyond the original total deadline', () => {
  const watch = new NativeProgressWatch(30, 0),
    events = [];
  for (const [now, type] of [
    [0, 'text'],
    [25, 'thinking'],
    [50, 'tool_use'],
  ]) {
    events.push(activity(String(now), type));
    assert.equal(watch.observe(native(events), now), false);
  }
  events.push({
    type: 'user',
    uuid: 'result',
    sessionId: 'session',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: '50',
          content: 'test failed',
          is_error: true,
        },
      ],
    },
  });
  assert.equal(watch.observe(native(events), 75), false);
  assert.equal(watch.observe(native(events), 104), false);
  assert.equal(watch.observe(native(events), 105), true);
});

test('metadata, duplicate records, API errors, other sessions and partial lines do not extend silence', () => {
  const watch = new NativeProgressWatch(30, 0),
    first = activity('read');
  watch.observe(native([first]), 0);
  const noise = [
    first,
    {
      ...first,
      timestamp: 'new timestamp',
      message: { ...first.message, usage: { tokens: 100 } },
    },
    { type: 'system', subtype: 'ai-title', title: 'changed' },
    { type: 'system', subtype: 'permission-mode', mode: 'changed' },
    { ...activity('sidechain'), isSidechain: true },
    { ...activity('foreign'), sessionId: 'other' },
    { ...activity('error'), isApiErrorMessage: true },
    { ...activity('api_error'), subtype: 'api_error' },
    { type: 'assistant', message: { content: [] } },
  ];
  assert.equal(watch.observe(native(noise, '{"type":"assistant"'), 29), false);
  assert.equal(
    watch.observe(native(noise, '{"type":"assistant","uuid":"new"'), 30),
    true,
  );
});

test('no native round expires, while new work after an API error remains observable', () => {
  const watch = new NativeProgressWatch(30, 0);
  assert.equal(watch.observe(null, 29), false);
  assert.equal(watch.observe(null, 30), true);
  const resumed = new NativeProgressWatch(30, 0);
  const events = [{ ...activity('error'), isApiErrorMessage: true }];
  resumed.observe(native(events), 20);
  events.push(activity('real-work'));
  assert.equal(resumed.observe(native(events), 29), false);
  assert.equal(resumed.observe(native(events), 58), false);
  assert.equal(resumed.observe(native(events), 59), true);
});

test('partial work counts only after parsing completes, and later user rounds stay outside observation', () => {
  const watch = new NativeProgressWatch(30, 0),
    event = activity('partial');
  const encoded = JSON.stringify(event);
  assert.equal(watch.observe(native([], encoded.slice(0, 40)), 20), false);
  assert.equal(watch.lastProgressAt, 0);
  assert.equal(watch.observe(native([event]), 25), false);
  const later = { ...user, uuid: 'later', message: { content: 'new task' } };
  assert.equal(
    watch.observe(native([event, later, activity('later-work')]), 55),
    true,
  );
});

test('identity and malformed complete records fail closed; invalid timeouts are rejected', () => {
  for (const value of [NaN, Infinity, 0, -1])
    assert.throws(() => new NativeProgressWatch(value), /正数/);
  const watch = new NativeProgressWatch(30, 0);
  watch.observe(native([activity('a')]), 0);
  assert.throws(
    () => watch.observe({ ...native([]), promptId: 'other' }, 1),
    /发生变化/,
  );
  assert.throws(() => native([], '{bad json\n'), /损坏/);
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-observation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  mkdirSync(path.join(root, id));
  const state = {
    taskId: id,
    containerId: 'original',
    results: {},
    pending: {
      turnId: 'turn',
      phase: 'sent',
      count: 1,
      previousIds: [],
      promptHash: createHash('sha256').update('task').digest('hex'),
    },
  };
  const rt = new DockerRuntime(root),
    events = [activity('initial')];
  rt.ensure = async () => state;
  rt.owned = () => ({ State: { Running: true } });
  rt.native = () => files(events);
  rt.confirmLocalCommand = async () => {};
  rt.export = async () => ({ verified: true });
  rt.permissionAudit = () => ({ passed: true });
  rt.publish = async () => {};
  const previous = process.env.RUNNER_TIMEOUT_MS;
  process.env.RUNNER_TIMEOUT_MS = '2000';
  t.after(() =>
    previous === undefined
      ? delete process.env.RUNNER_TIMEOUT_MS
      : (process.env.RUNNER_TIMEOUT_MS = previous),
  );
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const run = () =>
    rt.execute({ id }, { id: 'turn', prompt: 'task' }, () =>
      assert.fail('already sent; must not reserve or resend'),
    );
  return { state, events, run, rt };
}

test('execute reconnect observes live work past its old deadline without reserving or resending', async (t) => {
  const { state, events, run } = fixture(t);
  const result = run();
  await flush();
  for (let i = 1; i <= 3; i++) {
    events.push(activity('edit-' + i));
    t.mock.timers.tick(1500);
    await flush();
  }
  events.push({ type: 'system', subtype: 'turn_duration' });
  t.mock.timers.tick(3000); // Completion is processed even after an idle deadline.
  const value = await result;
  assert.equal(value.success, true);
  assert.equal(value.claudeCallCount, 1);
  assert.equal(value.promptId, 'prompt');
  assert.equal(value.sessionId, 'session');
  assert.equal(state.pending, undefined);
});

test('execute silence times out without terminating the container or clearing its sent receipt', async (t) => {
  const { state, run } = fixture(t),
    pending = structuredClone(state.pending);
  const result = run().then(
    () => assert.fail('silent round cannot succeed'),
    (error) => error,
  );
  await flush();
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(1500);
    await flush();
  }
  assert.match((await result).message, /没有新的原生执行记录/);
  assert.deepEqual(state.pending, pending);
  assert.deepEqual(state.results, {});
});

test('a completed round with a native API error still exports a failure immediately', async (t) => {
  const { events, run } = fixture(t);
  events.push({ ...activity('error'), isApiErrorMessage: true });
  events.push({ type: 'system', subtype: 'turn_duration' });
  const result = await run();
  assert.equal(result.success, false);
  assert.equal(result.executionOutcome, 'error');
  assert.equal(result.claudeCallCount, 1);
  assert.equal(result.traceExport.verified, true);
});

test('completion from a changed native identity is rejected before export', async (t) => {
  const { state, events, run, rt } = fixture(t);
  rt.export = () => assert.fail('foreign completion must not be exported');
  const result = run().then(
    () => assert.fail('foreign session cannot succeed'),
    (error) => error,
  );
  await flush();
  events.push({ type: 'system', subtype: 'turn_duration' });
  rt.native = () =>
    files(events).map((file) => ({
      ...file,
      content: file.content.replaceAll(
        '"sessionId":"session"',
        '"sessionId":"other"',
      ),
    }));
  t.mock.timers.tick(1500);
  assert.match((await result).message, /原生会话或题目发生变化/);
  assert.equal(state.pending.phase, 'sent');
  assert.equal(state.pending.count, 1);
  assert.deepEqual(state.results, {});
});
