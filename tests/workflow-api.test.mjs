import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
async function api(route, body, method = 'POST', auth = false) {
  const res = await fetch('http://localhost:3000' + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!res.ok) throw Error(d.error);
  return d;
}
const run = (b) => api('/api/runner', b, 'POST', true);
const original = (await api('/api/scheduler', null, 'GET')).config,
  ids = [];
async function create() {
  const { task } = await api('/api/tasks', {
    title: '__WORKFLOW_API__',
    repoPath: '/tmp/workflow-api-fixture',
    stack: 'fixture',
    category: 'Feature 迭代',
    difficulty: '中等',
    reproducibility: '无外部依赖',
    autoStart: true,
  });
  ids.push(task.id);
  writeFileSync('.runner/workflow-api-ids', JSON.stringify(ids));
  return task;
}
const current = async (id) =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    autoContinue: true,
    concurrency: 1,
  });
  const task = await create();
  let { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, task.id);
  const finish = {
    action: 'finish',
    taskId: task.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    success: true,
    automation: {
      next: {
        value: {
          action: 'repair',
          prompt: 'Repair failed edge case',
          reason: 'failed test',
        },
      },
    },
    preparation: { category: 'Bug 修复', difficulty: '中等', stack: 'Go' },
    harnessVersion: 'fixture',
    os: 'fixture',
  };
  await run(finish);
  await run(finish);
  let t = await current(task.id);
  assert.equal(t.turns.length, 2);
  assert.equal(t.turns[1].autoFollowup, true);
  assert.equal(t.turns[0].stack, 'Go');
  assert.equal(t.turns[1].status, 'queued');
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  await run({
    action: 'recover',
    taskId: t.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    live: true,
  });
  t = await current(t.id);
  assert.equal(t.turns[1].recoveryBlocked, true);
  assert.equal(t.turns[1].recoveryToken, undefined);
  await assert.rejects(() =>
    api(
      '/api/tasks/' + t.id,
      { action: 'retry', turnId: job.turn.id, revision: t.revision },
      'PATCH',
    ),
  );
  await run({
    action: 'recover',
    taskId: t.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    live: false,
    salvage: {
      success: true,
      workDir: '/tmp/fixture',
      sessionId: 'old-session',
    },
  });
  t = await current(t.id);
  assert.equal(t.turns[1].status, 'queued');
  assert.equal(t.sessionId, 'old-session');
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    autoContinue: false,
    concurrency: 1,
  });
  await run({ ...finish, turnId: job.turn.id, jobToken: job.turn.jobToken });
  t = await current(t.id);
  assert.equal(t.turns.length, 2);
  const uncertain = await create();
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  assert.equal(job.task.id, uncertain.id);
  await run({
    action: 'recover',
    taskId: uncertain.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    live: false,
  });
  assert.equal((await current(uncertain.id)).turns[0].status, 'failed');
  assert.equal((await run({ action: 'claim', capacity: 1 })).job, null);
  console.log(
    'Workflow API passed: idempotent continuation, pause, living orphan block, cached result recovery, uncertain result stop.',
  );
} finally {
  await api('/api/scheduler', original);
}
