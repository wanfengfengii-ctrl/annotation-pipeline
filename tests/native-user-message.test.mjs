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
