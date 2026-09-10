// Integration with synthetic CLI responses and Docker adapter; no real model calls.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { questionIssues } from '../lib/writing-style.mjs';
import { questionRules } from '../lib/question-writing.mjs';
import {
  fixture,
  api,
  start,
  stop,
  waitTask,
  create,
  calls,
} from './fixtures/flow-helper.mjs';
const f = fixture('docker-flow'),
  original = (await api('/api/scheduler', null, 'GET')).config;
let child;
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    useHistory: false,
    repos: [],
    autoContinue: true,
    concurrency: 3,
  });
  writeFileSync(path.join(f.bin, 'fail-score-once'), '1');
  const task = await create(f, '__DOCKER_TEN_ROUNDS__');
  child = start(f);
  let t = await waitTask(task.id, (t) => t.turns[0].status === 'failed');
  assert.equal(t.turns[0].stage, 'score', f.errors);
  await api(
    '/api/tasks/' + t.id,
    { action: 'retry', turnId: t.turns[0].id, revision: t.revision },
    'PATCH',
  );
  t = await waitTask(
    task.id,
    (t) =>
      t.turns.some((r) => r.status === 'failed' || r.automation?.nextError) ||
      (t.turns.length === 32 && t.turns.every((r) => r.status === 'review')),
    300000,
  );
  assert.equal(
    t.turns.length,
    32,
    JSON.stringify(t.turns.at(-1)) + ' ' + f.errors,
  );
  assert.equal(new Set(t.turns.map((r) => r.sessionId)).size, 22);
  assert.equal(new Set(t.turns.map((r) => r.promptId)).size, 32);
  for (const r of t.turns) {
    assert.deepEqual(
      questionIssues(r.prompt, { category: r.category }),
      [],
      r.category,
    );
    assert.equal(
      r.automation.policy.questionRuleVersion,
      questionRules.version,
    );
    assert.equal(r.automation.policy.value.questionCompliant, true);
  }
  assert.equal(new Set(t.turns.map((r) => r.container.workDir)).size, 22);
  assert.equal(Object.keys(t.initialCodeSnapshots).length, 22);
  for (const r of t.turns) {
    assert.ok(
      t.initialCodeSnapshots[r.questionRootId]?.url.startsWith(
        'https://github.com/',
      ),
    );
    assert.ok(
      calls(f).find(
        (e) => e.name === 'initial-code' && e.questionId === r.questionRootId,
      ).time <=
        calls(f).find((e) => e.name === 'claude' && e.turnId === r.id).time,
    );
  }
  assert.ok(
    t.turns.every((r) => r.roundNumber <= 3 && r.permissionAudit.passed),
  );
  assert.ok(
    t.turns
      .filter((r) => !r.repairOf)
      .slice(1)
      .every((r) => r.container.sourceSnapshot.importedAfterStartup),
  );
  assert.equal(
    calls(f).filter((e) => e.name === 'claude' && e.event === 'start').length,
    32,
    'score retry cannot invoke Claude again',
  );
  assert.equal(t.turns.flatMap((r) => r.claudeAttempts).length, 32);
  assert.equal(calls(f).filter((e) => e.name === 'scaffold').length, 1);
  assert.equal(
    calls(f).filter((e) => e.name === 'snapshot').length,
    22,
    '独立会话核验一次初始快照，评分重试和同会话 Bug 追问不拿产物重新比较骨架',
  );
  assert.deepEqual(
    ['0-1 代码生成', 'Feature 迭代', 'Bug 修复', '代码理解', '代码重构'].map(
      (c) => t.turns.slice(0, 26).filter((r) => r.category === c).length,
    ),
    [7, 7, 10, 1, 1],
  );
  assert.ok(
    t.turns
      .filter((r) => r.repairOf)
      .every(
        (r) =>
          r.sessionId === t.turns.find((p) => p.id === r.repairOf).sessionId,
      ),
  );
  assert.ok(
    t.turns.every(
      (r) =>
        r.traceExport.verified &&
        r.review.source === 'codex' &&
        r.automation.archive,
    ),
  );
  t = await waitTask(task.id, (t) => t.container?.status === 'removed');
  await assert.rejects(
    api(
      '/api/tasks/' + t.id,
      {
        action: 'enqueue',
        prompt: 'eleventh',
        category: 'Feature 迭代',
        difficulty: '中等',
        revision: t.revision,
      },
      'PATCH',
    ),
    /容器|十|10/,
  );
  const blocked = await create(f, '__POLICY_REJECT__');
  const rejected = await waitTask(
    blocked.id,
    (t) => t.turns[0].status === 'failed',
  );
  assert.equal(rejected.turns[0].stage, 'policy');
  assert.equal(
    calls(f).filter((e) => e.name === 'claude' && e.event === 'start').length,
    32,
  );
  await api(
    '/api/tasks/' + rejected.id,
    { action: 'close', revision: rejected.revision },
    'PATCH',
  );
  await waitTask(rejected.id, (t) => t.container?.status === 'removed');
  console.log(
    'Terminal pipeline: 32 rounds, 22 sessions, 7:7:10:1:1 mix, one scaffold, 10+10 project caps, repair reuse, retry, policy and archive passed',
  );
} finally {
  await stop(child);
  await api('/api/scheduler', original);
}
