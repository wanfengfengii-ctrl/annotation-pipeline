// Synthetic records only. Use the dedicated test server; never invokes a CLI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, base } from './fixtures/flow-helper.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { permissionAuditVersion } from '../lib/permission-audit.mjs';
assert.equal(
  new URL(base).port,
  '3001',
  'Lifecycle fixtures require the test server',
);
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
async function run(body) {
  const r = await fetch(base + '/api/runner', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error);
  return result;
}
const config = (await api('/api/scheduler', null, 'GET')).config;
const latest = async (id) =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
const change = async (id, body) =>
  api(
    '/api/tasks/' + id,
    { ...body, revision: (await latest(id)).revision },
    'PATCH',
  );
const context = () => run({ action: 'supply-context' });
async function create(name) {
  const { task } = await api('/api/tasks', {
    title: '__LIFECYCLE__' + name,
    repoPath: '/tmp/lifecycle-fixture',
    stack: 'fixture',
    category: '0-1 代码生成',
    difficulty: '中等',
    reproducibility: '无外部依赖',
    projectSeries: true,
    autoStart: true,
  });
  assert.equal((await run({ action: 'claim', capacity: 0 })).job, null);
  const { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, task.id);
  const container = {
    taskId: task.id,
    questionId: job.turn.id,
    name: 'annotation-' + task.id,
    image: containerImage,
    imageId: 'sha256:' + 'a'.repeat(64),
    snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
    policyVersion: containerPolicyVersion,
    status: 'running',
    workDir: '/fixture/' + task.id + '/workspace',
    terminalIdentity: {
      transport: 'mac-terminal',
      runId: job.turn.id,
      realTerminal: true,
      tty: '/dev/fixture',
    },
  };
  await run({ action: 'container', taskId: task.id, container });
  return { task, job, container };
}
async function finish(f, extra = {}) {
  return run({
    action: 'finish',
    taskId: f.task.id,
    turnId: f.job.turn.id,
    jobToken: f.job.turn.jobToken,
    success: true,
    sessionId: 'session-' + f.task.id,
    promptId: f.job.turn.id,
    container: f.container,
    tracePath: '/fixture/trace-' + f.job.turn.id,
    traceExport: {
      verified: true,
      path: '/fixture/projects',
      files: 1,
      sha256: 'a'.repeat(64),
    },
    permissionAudit: {
      version: permissionAuditVersion,
      passed: true,
      modeVerified: true,
      denialCount: 0,
      traceSha256: 'a'.repeat(64),
    },
    ...extra,
  });
}
async function repair(f, prompt) {
  await change(f.task.id, {
    action: 'enqueue',
    category: 'Bug 修复',
    difficulty: '中等',
    prompt,
  });
  f.job = (await run({ action: 'claim', capacity: 1 })).job;
  assert.equal(f.job.task.id, f.task.id);
}
try {
  await api('/api/scheduler', {
    ...config,
    enabled: false,
    autoContinue: false,
    concurrency: 1,
  });
  const f = await create('third-failure');
  await finish(f, { reproducibility: '无外部依赖' });
  await repair(f, '分页切换后列表没有刷新，把刷新逻辑修好');
  const secondId = f.job.turn.id;
  await finish(f, { reproducibility: '有外部依赖，未容器化' });
  await repair(f, '切换筛选后页码没有归一，把页码重置补上');
  await finish(f, { success: false, error: 'fixture response unconfirmed' });
  assert.equal(
    (await context()).containerTasks.find((t) => t.id === f.task.id)
      .finishContainer,
    false,
  );
  await change(f.task.id, { action: 'retry', turnId: f.job.turn.id });
  f.job = (await run({ action: 'claim', capacity: 1 })).job;
  await finish(f);
  assert.equal(
    (await context()).containerTasks.find((t) => t.id === f.task.id)
      .finishContainer,
    true,
  );
  await assert.rejects(
    repair(f, '还有一处重复提交，把重复提交修好'),
    /会话|修复/,
  );
  const saved = await latest(f.task.id);
  assert.equal(saved.turns[0].reproducibility, '无外部依赖');
  assert.equal(
    saved.turns.find((t) => t.id === secondId).reproducibility,
    '有外部依赖，未容器化',
  );
  await change(f.task.id, { action: 'close' });

  await api('/api/scheduler', {
    ...config,
    enabled: false,
    autoContinue: true,
    concurrency: 1,
  });
  const ended = await create('complete-before-cleanup');
  await finish(ended, {
    automation: {
      next: { value: { action: 'complete', reason: 'fixture complete' } },
    },
  });
  assert.equal((await latest(ended.task.id)).turns[0].sessionFinished, true);
  await assert.rejects(repair(ended, '结果没有刷新，把刷新补上'), /会话|修复/);
  await change(ended.task.id, { action: 'close' });

  const excluded = await create('excluded-failure');
  await finish(excluded, {
    success: false,
    error: 'fixture engineering failure',
  });
  assert.equal(
    (await context()).history.find((t) => t.id === excluded.task.id).failed,
    true,
  );
  await change(excluded.task.id, {
    action: 'exclude',
    turnId: excluded.job.turn.id,
    reason: '测试夹具模拟网络故障，排除该记录',
  });
  assert.equal(
    (await context()).history.find((t) => t.id === excluded.task.id).failed,
    false,
  );
  assert.equal(
    (await context()).containerTasks.find((t) => t.id === excluded.task.id)
      .finishContainer,
    true,
  );
  await change(excluded.task.id, { action: 'close' });
  console.log(
    'Lifecycle API passed: zero capacity, failed third-turn recovery, completed-session gate, per-turn environment and excluded-failure handling',
  );
} finally {
  await api('/api/scheduler', config);
}
