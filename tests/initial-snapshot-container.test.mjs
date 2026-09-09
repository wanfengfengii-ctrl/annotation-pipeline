import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitialSnapshotContainer } from '../lib/initial-code-snapshot.mjs';

const taskId = 'task',
  questionId = 'current';
const container = (extra = {}) => ({
  taskId,
  questionId,
  containerId: 'container',
  name: 'annotation-task',
  workDir: '/current/workspace',
  imageId: 'sha256:' + 'a'.repeat(64),
  snapshot: 'docker://image@sha256:' + 'a'.repeat(64),
  sourceSnapshot: {
    manifestPath: '/frozen/current.json',
    sha256: 'b'.repeat(64),
    files: 21,
  },
  ...extra,
});
const select = (turn, task) =>
  resolveInitialSnapshotContainer(taskId, questionId, turn, task);

test('a failed context record from the prior question cannot select its old source manifest', () => {
  const old = container({
    questionId: 'previous',
    containerId: 'old',
    sourceSnapshot: {
      manifestPath: '/frozen/old.json',
      sha256: 'c'.repeat(64),
      files: 19,
    },
  });
  const current = container(),
    original = structuredClone([old, current]);
  assert.equal(select(old, current), current);
  assert.deepEqual([old, current], original);
});
test('a historical question keeps its own frozen container after the task advances', () => {
  const current = container();
  assert.equal(
    select(current, container({ questionId: 'next', containerId: 'next' })),
    current,
  );
});
test('missing question matches and foreign task identities fail closed', () => {
  assert.throws(
    () =>
      select(
        container({ questionId: 'old' }),
        container({ questionId: 'next' }),
      ),
    /实际原题/,
  );
  assert.throws(
    () => select(container({ taskId: 'another' }), container()),
    /任务不符/,
  );
});
test('two records for the same question cannot disagree about container identity', () => {
  for (const key of ['containerId', 'name', 'workDir', 'imageId', 'snapshot'])
    assert.throws(
      () => select(container(), container({ [key]: 'different' })),
      /身份冲突/,
      key,
    );
});
test('two frozen subjects for one question cannot change kind, path, digest, or count', () => {
  const first = container();
  for (const [key, value] of [
    ['manifestPath', '/other'],
    ['sha256', 'd'.repeat(64)],
    ['files', 22],
  ]) {
    const second = container();
    second.sourceSnapshot[key] = value;
    assert.throws(() => select(first, second), /清单冲突/, key);
  }
  assert.throws(
    () =>
      select(
        first,
        container({
          sourceSnapshot: undefined,
          scaffoldSnapshot: first.sourceSnapshot,
        }),
      ),
    /清单冲突/,
  );
});
test('matching bootstrap records may acquire a frozen subject but invalid subjects cannot be ignored', () => {
  const initial = container({ sourceSnapshot: undefined }),
    ready = container();
  assert.equal(select(initial, ready), ready);
  assert.throws(
    () => select(initial, container({ sourceSnapshot: undefined })),
    /缺少.*清单/,
  );
  assert.throws(
    () => select(container({ sourceSnapshot: { sha256: 'broken' } }), ready),
    /缺少.*清单/,
  );
});
