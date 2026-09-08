import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
async function api(route, body, method = 'POST', auth = false) {
  const r = await fetch('http://localhost:3000' + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const run = (b) => api('/api/runner', b, 'POST', true);
const config = (await api('/api/scheduler', null, 'GET')).config;
try {
  await api('/api/scheduler', {
    ...config,
    enabled: false,
    autoContinue: true,
    concurrency: 1,
  });
  const { task } = await api('/api/tasks', {
    title: '__AUDIT_API__',
    repoPath: '/tmp/audit-fixture',
    projectSeries: true,
    category: '0-1 代码生成',
    difficulty: '困难',
    stack: 'TS',
    reproducibility: '无外部依赖',
    autoStart: true,
  });
  writeFileSync('.runner/audit-api-id', task.id);
  const current = async () =>
    (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === task.id);
  const patch = async (b) =>
    api(
      '/api/tasks/' + task.id,
      { ...b, revision: (await current()).revision },
      'PATCH',
    );
  let { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, task.id);
  const finish = (extra) =>
    run({
      action: 'finish',
      taskId: task.id,
      turnId: job.turn.id,
      jobToken: job.turn.jobToken,
      success: true,
      sessionId: 'audit-session',
      promptId: 'audit-' + job.turn.id,
      tracePath: '/fixture/trace',
      snapshot: 'https://github.com/fixture/project/commit/' + 'a'.repeat(40),
      harnessVersion: 'fixture',
      os: 'fixture',
      review: {
        source: 'codex',
        scores: [2, 3, 3, 4, 4],
        descriptions: ['a', 'b', 'c', 'd', 'e'],
      },
      automation: {
        bundlePath: '/fixture/bundle',
        delivery: { value: { passed: true } },
      },
      ...extra,
    });
  await finish({
    evaluationPrompt: '原始完整目标',
    automation: {
      bundlePath: '/fixture/bundle',
      delivery: { value: { passed: true } },
      next: {
        value: {
          action: 'advance',
          category: 'Feature 迭代',
          difficulty: '困难',
          baseComplete: false,
          projectEvidence: 'file',
          prompt: 'new feature',
          reason: 'invalid model decision',
        },
      },
    },
  });
  let t = await current();
  assert.equal(t.turns[0].status, 'review');
  assert.equal(t.turns.length, 1);
  assert.match(t.turns[0].automation.nextError, /基础项目/);
  await assert.rejects(
    () =>
      patch({
        action: 'trace',
        turnId: t.turns[0].id,
        promptId: 'replacement',
        tracePath: '/replacement',
      }),
    /评分或归档/,
  );
  await patch({
    action: 'enqueue',
    prompt: '继续',
    category: 'Feature 迭代',
    difficulty: '困难',
  });
  t = await current();
  assert.equal(t.turns[1].category, '0-1 代码生成');
  assert.equal(t.turns[1].evaluationPrompt, '原始完整目标');
  assert.equal(t.turns[1].continuationOf, t.turns[0].id);
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  await finish({
    success: false,
    error: 'fixture network fault',
    review: undefined,
    automation: {},
  });
  await assert.rejects(
    () =>
      patch({
        action: 'enqueue',
        prompt: 'new work',
        category: 'Feature 迭代',
        difficulty: '困难',
      }),
    /先处理/,
  );
  t = await current();
  const failed = t.turns[1].id;
  await patch({
    action: 'exclude',
    turnId: failed,
    reason: 'Synthetic network failure with no feedback value',
  });
  await patch({
    action: 'enqueue',
    prompt: 'next independent feature',
    category: 'Feature 迭代',
    difficulty: '困难',
  });
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  await finish({});
  await assert.rejects(
    () => patch({ action: 'retry', turnId: failed }),
    /历史轮次/,
  );
  t = await current();
  await patch({
    action: 'submit',
    turnId: t.turns[0].id,
    submitter: 'fixture',
    receipt: 'fixture://actual',
  });
  await assert.rejects(
    () =>
      patch({
        action: 'submit',
        turnId: t.turns[0].id,
        receipt: 'fixture://overwrite',
      }),
    /不可覆盖/,
  );
  console.log(
    'Audit API passed: invalid next plan preserves scored round, continuation inherits goal/type, unfinished work blocks new edits, archived identity and old rounds are immutable, receipt cannot be overwritten.',
  );
} finally {
  await api('/api/scheduler', config);
}
