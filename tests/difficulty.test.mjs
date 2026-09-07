import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDifficulty,
  assertPolicyAudit,
  rules,
  candidateDigest,
} from '../lib/task-policy.mjs';
const evidence = {
  simpleFeatures: [],
  difficultyEvidence: [
    '需理解事务与恢复调用链',
    '依赖仓库日志协议',
    '需要规划及故障注入验证',
    '跨存储和恢复模块',
  ],
  assessedDifficulty: '困难',
  followupFix: false,
  followupReason: '独立首轮任务',
};
test('difficulty lower bound is enforced from all six two-feature combinations regardless of claimed label', () => {
  const ids = ['scope', 'context', 'interaction', 'breadth'];
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++)
      assert.throws(
        () =>
          assertDifficulty({
            ...evidence,
            simpleFeatures: [ids[i], ids[j]],
            assessedDifficulty: '地狱',
          }),
        /过于简单/,
      );
  assert.doesNotThrow(() =>
    assertDifficulty({ ...evidence, simpleFeatures: ['breadth'] }),
  );
  assert.doesNotThrow(() =>
    assertDifficulty({ ...evidence, assessedDifficulty: '地狱' }),
  );
});
test('simple first turns and missing evidence fail; prior artifact bug fixes have a narrow exception', () => {
  assert.throws(
    () => assertDifficulty({ ...evidence, assessedDifficulty: '简单' }),
    /首轮/,
  );
  assert.throws(
    () => assertDifficulty({ ...evidence, difficultyEvidence: ['blank'] }),
    /证据/,
  );
  assert.throws(
    () => assertDifficulty({ ...evidence, simpleFeatures: ['scope', 'scope'] }),
    /证据/,
  );
  const repair = {
    ...evidence,
    assessedDifficulty: '简单',
    simpleFeatures: ['scope', 'breadth'],
    followupFix: true,
    followupReason: '修复前轮生成的错误边界判断',
  };
  assert.throws(
    () =>
      assertDifficulty(repair, { firstTurn: false, allowFollowupFix: false }),
    /前序产物/,
  );
  assert.doesNotThrow(() =>
    assertDifficulty(repair, { firstTurn: false, allowFollowupFix: true }),
  );
  assert.throws(
    () =>
      assertDifficulty(
        { ...repair, followupFix: false },
        { firstTurn: false, allowFollowupFix: true },
      ),
    /过于简单/,
  );
});
test('a model allowed=true cannot bypass the deterministic difficulty gate and UI gets a rejection', async () => {
  const digest = await candidateDigest({ title: 'synthetic' });
  const audit = {
    engine: 'codex-cli',
    ruleVersion: rules.version,
    candidateDigest: digest,
    tracePath: '/fixture',
    threadId: 'fixture',
    value: {
      ...evidence,
      simpleFeatures: ['scope', 'context'],
      allowed: true,
      matchedRuleIds: [],
      duplicateTaskIds: [],
      checkedGroups: rules.groups.map((g) => g.id),
      reason: 'model says pass',
    },
  };
  assert.throws(() => assertPolicyAudit(audit, digest), /过于简单/);
  assert.equal(audit.accepted, false);
  assert.match(audit.rejection, /2 \/ 4/);
});
