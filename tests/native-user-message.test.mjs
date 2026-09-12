import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DockerRuntime,
  readNativeTurn,
  assertNativeSessionIdle,
} from '../scripts/docker-runtime.mjs';
import { isNativeUserMessage } from '../lib/native-user-message.mjs';

const user = {
  type: 'user',
  uuid: 'real-prompt',
  sessionId: 'session',
  message: { content: 'fix the preview' },
};
const companion = {
  ...user,
  uuid: 'image-note',
  isMeta: true,
  turnCompanion: true,
  message: { content: '[Image: original 2424x1728, displayed at 2000x1426.]' },
};
const duration = { type: 'system', subtype: 'turn_duration' };
const files = (events) => [
  {
    name: 'session.jsonl',
    content: events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  },
];

test('image companions remain in original evidence without splitting the real task', () => {
  const input = files([
    user,
    companion,
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done' }] },
    },
    duration,
  ]);
  const result = readNativeTurn(input, user.message.content);
  assert.equal(result.complete, true);
  assert.equal(result.promptId, user.uuid);
  assert.equal(result.nativeContent, input[0].content);
  assert.match(result.content, /image-note/);
  assert.equal(result.output, 'done');
  assert.equal(isNativeUserMessage(companion), false);
  assert.equal(
    isNativeUserMessage({ ...companion, isMeta: false, turnCompanion: false }),
    true,
  );
});

test('a genuine later user still ends the round; meta or sidechain cannot select its identity', () => {
  const metaSamePrompt = { ...companion, message: user.message };
  const result = readNativeTurn(
    files([
      metaSamePrompt,
      user,
      companion,
      { ...user, uuid: 'second', message: { content: 'another task' } },
      duration,
    ]),
    user.message.content,
  );
  assert.equal(result.complete, false);
  assert.equal(result.promptId, user.uuid);
  assert.equal(
    readNativeTurn(
      files([{ ...user, isSidechain: true }, duration]),
      user.message.content,
    ),
    null,
  );
});

test('terminal idle identity stays on the real user when metadata follows completion', () => {
  const state = {
    sessionId: 'session',
    results: {
      task: {
        success: true,
        sessionId: 'session',
        promptId: user.uuid,
        traceExport: { verified: true },
      },
    },
  };
  assert.deepEqual(
    assertNativeSessionIdle(state, files([user, duration, companion]))
      .completedPromptIds,
    [user.uuid],
  );
  assert.throws(
    () =>
      assertNativeSessionIdle(
        state,
        files([user, duration, { ...user, uuid: 'new' }]),
      ),
    /尚未确认完成/,
  );
});

test('a sent interaction with image companions resumes into a saved result without reserve or input', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'native-companion-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = {
    taskId: 'task',
    sessionId: 'session',
    results: {},
    pending: {
      turnId: 'turn',
      promptHash: (await import('node:crypto'))
        .createHash('sha256')
        .update(user.message.content)
        .digest('hex'),
      phase: 'sent',
      previousIds: [],
      count: 2,
    },
  };
  const runtime = Object.create(DockerRuntime.prototype);
  runtime.ensure = async () => state;
  runtime.shouldStop = () => false;
  runtime.owned = () => ({ State: { Running: true } });
  runtime.native = () => files([user, companion, duration]);
  runtime.export = async () => ({ verified: true });
  runtime.permissionAudit = () => ({ passed: true });
  runtime.file = () => path.join(dir, 'container.json');
  runtime.publish = async () => {};
  const result = await runtime.execute(
    { id: 'task' },
    { id: 'turn', prompt: user.message.content, repairOf: 'first' },
    () => {
      throw Error('must not reserve or resend');
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.promptId, user.uuid);
  assert.equal(result.claudeCallCount, 2);
  assert.equal(state.pending, undefined);
  assert.match(
    readFileSync(path.join(dir, 'turn.native.jsonl'), 'utf8'),
    /image-note/,
  );
});

for (const actual of [' ' + user.message.content, user.message.content + '\n'])
  test(
    'transport padding identifies the sent prompt while preserving original bytes: ' +
      JSON.stringify(actual),
    () => {
      const input = files([
        { ...user, message: { content: actual } },
        duration,
      ]);
      const result = readNativeTurn(input, user.message.content);
      assert.equal(result.complete, true);
      assert.equal(result.nativeContent, input[0].content);
      assert.equal(
        JSON.parse(result.content.split('\n')[0]).message.content,
        actual,
      );
      assert.equal(
        readNativeTurn(input, user.message.content, [user.uuid]),
        null,
      );
      assert.equal(
        readNativeTurn(
          files([
            { ...user, isMeta: true, message: { content: actual } },
            duration,
          ]),
          user.message.content,
        ),
        null,
      );
    },
  );

test('prompt matching does not trim arbitrary whitespace or merge different business text', () => {
  for (const actual of ['  ', '\t', '\n']
    .map((p) => p + user.message.content)
    .concat([
      user.message.content + '\n\n',
      user.message.content.replace('the', 'a'),
    ]))
    assert.equal(
      readNativeTurn(
        files([{ ...user, message: { content: actual } }, duration]),
        user.message.content,
      ),
      null,
    );
});

test('a stopped completed session is captured without starting Docker or sending input', async (t) => {
  const fs = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'native-stopped-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = files([
    { ...user, message: { content: ' ' + user.message.content } },
    duration,
  ])[0].content;
  fs.mkdirSync(path.join(dir, 'export'));
  fs.writeFileSync(path.join(dir, 'export/session.jsonl'), trace);
  const state = {
    taskId: 'task',
    questionId: 'turn',
    status: 'stopped',
    results: {},
    pending: {
      turnId: 'turn',
      phase: 'sent',
      count: 1,
      previousIds: [],
      promptHash: (await import('node:crypto'))
        .createHash('sha256')
        .update(user.message.content)
        .digest('hex'),
    },
  };
  const runtime = Object.create(DockerRuntime.prototype);
  runtime.load = () => state;
  runtime.owned = () => ({ State: { Running: false } });
  runtime.export = async () => ({
    verified: true,
    path: path.join(dir, 'export'),
  });
  runtime.permissionAudit = () => ({ passed: true });
  runtime.file = () => path.join(dir, 'container.json');
  runtime.publish = async () => {};
  const result = await runtime.captureStoppedTurn(
    { id: 'task' },
    { id: 'turn' },
    user.message.content,
  );
  assert.equal(result.success, true);
  assert.equal(result.stoppedCompletion, true);
  assert.equal(state.results.turn.stoppedCompletion, true);
  assert.equal(result.claudeCallCount, 1);
  assert.equal(state.status, 'stopped');
  assert.equal(state.pending, undefined);
  assert.equal(
    readFileSync(path.join(dir, 'turn.native.jsonl'), 'utf8'),
    trace,
  );
  state.pending = {
    turnId: 'turn',
    phase: 'sent',
    count: 1,
    promptHash: 'wrong',
  };
  await assert.rejects(
    runtime.captureStoppedTurn(
      { id: 'task' },
      { id: 'turn' },
      user.message.content,
    ),
    /已发送回执/,
  );
});
