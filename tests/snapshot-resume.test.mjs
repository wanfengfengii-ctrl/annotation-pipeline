import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeInitialSnapshot } from '../lib/snapshot-resume.mjs';
const env = {
  taskId: 'task',
  questionId: 'question',
  containerId: 'container',
  imageId: 'sha256:image',
  snapshot: 'docker://image',
  workDir: '/task/workspace',
  running: true,
  isolationVerified: true,
  permissionPreflight: { passed: true },
  terminalIdentity: { runId: 'terminal', realTerminal: true },
  mount: {
    source: '/task/workspace',
    destination: '/workspace',
    writable: true,
  },
};
const snapshot = {
  engine: 'codex-cli',
  threadId: 'thread',
  tracePath: '/original/trace',
  value: { ready: true, notes: ['初始骨架已核验'] },
  environmentEvidence: env,
};
test('重连只核验运行环境，保留原始快照与已产出的代码', () => {
  const original = structuredClone(snapshot);
  const resumed = resumeInitialSnapshot(
    snapshot,
    { ...env, checkedAt: 'now' },
    '/recheck.json',
  );
  assert.deepEqual(snapshot, original);
  assert.equal(resumed.value, snapshot.value);
  assert.equal(resumed.environmentEvidence, env);
  assert.equal(resumed.resumeChecks[0].initialCodeRechecked, false);
  assert.equal(resumed.resumeChecks[0].environmentEvidence.checkedAt, 'now');
});
test('原始记录缺失、环境变更或权限失败不能跳过核验', () => {
  assert.throws(() => resumeInitialSnapshot(null, env, '/recheck'));
  for (const field of [
    'taskId',
    'questionId',
    'containerId',
    'imageId',
    'snapshot',
    'workDir',
  ])
    assert.throws(() =>
      resumeInitialSnapshot(
        snapshot,
        { ...env, [field]: 'changed' },
        '/recheck',
      ),
    );
  for (const change of [
    { running: false },
    { isolationVerified: false },
    { permissionPreflight: { passed: false } },
    { terminalIdentity: { runId: 'other', realTerminal: true } },
    { mount: { ...env.mount, source: '/other' } },
  ])
    assert.throws(() =>
      resumeInitialSnapshot(snapshot, { ...env, ...change }, '/recheck'),
    );
});
