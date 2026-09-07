import { rules, candidateDigest } from '../lib/task-policy.mjs';
// Run against an empty local test workspace with the real runner stopped.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fingerprint } from '../scripts/scheduler.mjs';
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
async function call(route, body, method = 'POST', auth = false) {
  const r = await fetch(base + route, {
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
const run = async (b) => {
  if (b.action === 'enqueue-auto')
    b = {
      ...b,
      policyAudit: {
        engine: 'codex-cli',
        ruleVersion: rules.version,
        candidateDigest: await candidateDigest(b),
        tracePath: '/synthetic/policy',
        threadId: 'fixture',
        value: {
          allowed: true,
          matchedRuleIds: [],
          duplicateTaskIds: [],
          checkedGroups: rules.groups.map((g) => g.id),
          reason: 'synthetic pass',
        },
      },
    };
  return call('/api/runner', b, 'POST', true);
};
const original = (await call('/api/scheduler', null, 'GET')).config;
const ids = [];
writeFileSync('.runner/scheduler-test-ids', '');
const draft = {
  title: '__SCHEDULER_TEST__',
  repoPath: '/tmp/scheduler-test',
  stack: 'fixture',
  category: '代码测试',
  difficulty: '中等',
  reproducibility: '无外部依赖',
  autoStart: true,
};
const finish = (job) =>
  run({
    action: 'finish',
    taskId: job.task.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    success: true,
    output: 'Synthetic scheduler test',
  });
const remember = (t) => {
  ids.push(t.id);
  writeFileSync('.runner/scheduler-test-ids', JSON.stringify(ids));
};
try {
  await call('/api/scheduler', {
    ...original,
    enabled: false,
    concurrency: 3,
    useHistory: false,
    repos: [draft.repoPath],
    dailyLimit: 2,
  });
  for (let i = 0; i < 6; i++)
    remember(
      (await call('/api/tasks', { ...draft, title: draft.title + i })).task,
    );
  const claimed = (
    await Promise.all(
      Array.from({ length: 12 }, () => run({ action: 'claim', capacity: 3 })),
    )
  )
    .filter((r) => r.job)
    .map((r) => r.job);
  assert.equal(
    claimed.length,
    3,
    'simultaneous claims must respect global limit',
  );
  assert.equal(
    new Set(claimed.map((j) => j.task.id)).size,
    3,
    'a task cannot be claimed twice',
  );
  assert.equal((await run({ action: 'claim', capacity: 3 })).job, null);
  await finish(claimed[0]);
  const next = (await run({ action: 'claim', capacity: 3 })).job;
  assert.ok(next);
  await call('/api/scheduler', {
    ...original,
    enabled: false,
    concurrency: 1,
    useHistory: false,
    repos: [draft.repoPath],
    dailyLimit: 2,
  });
  assert.equal(
    (await run({ action: 'claim', capacity: 4 })).job,
    null,
    'lowering cap must stop new starts',
  );
  await Promise.all([...claimed.slice(1), next].map(finish));
  while (true) {
    const { job } = await run({ action: 'claim', capacity: 1 });
    if (!job) break;
    await finish(job);
  }
  await call('/api/scheduler', {
    ...original,
    enabled: true,
    concurrency: 3,
    useHistory: false,
    repos: [draft.repoPath],
    dailyLimit: 2,
  });
  const payload = {
    action: 'enqueue-auto',
    ...draft,
    prompt: 'Synthetic generated task',
    tracePath: '/synthetic/generate.jsonl',
    fingerprint: fingerprint(draft.repoPath, 'Synthetic generated task'),
  };
  await assert.rejects(
    () => call('/api/runner', payload, 'POST', true),
    /审核记录/,
  );
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => run(payload)),
  );
  let ctx = await run({ action: 'supply-context' });
  assert.equal(
    ctx.generatedToday,
    1,
    'racing supply inserts must be idempotent',
  );
  remember({ id: responses.find((r) => r.taskId).taskId });
  assert.ok((await run(payload)).duplicate);
  assert.ok(
    (
      await run({
        ...payload,
        fingerprint: fingerprint(draft.repoPath, 'next'),
        prompt: 'next',
      })
    ).skipped,
    'nonempty queue must block supply',
  );
  await finish((await run({ action: 'claim', capacity: 3 })).job);
  const second = await run({
    ...payload,
    title: '__SCHEDULER_TEST__auto2',
    fingerprint: fingerprint(draft.repoPath, 'next'),
    prompt: 'next',
  });
  remember({ id: second.taskId });
  await finish((await run({ action: 'claim', capacity: 3 })).job);
  assert.ok(
    (
      await run({
        ...payload,
        fingerprint: fingerprint(draft.repoPath, 'third'),
        prompt: 'third',
      })
    ).skipped,
    'daily quota must hold',
  );
  await call('/api/scheduler', { ...original, enabled: false });
  assert.ok(
    (
      await run({
        ...payload,
        fingerprint: fingerprint(draft.repoPath, 'paused'),
        prompt: 'paused',
      })
    ).skipped,
  );
  console.log(
    'Scheduler API passed: 12 racing claims, distinct jobs, live concurrency reduction, idempotent supply, nonempty queue, daily quota and pause.',
  );
} finally {
  await call('/api/scheduler', original);
}
