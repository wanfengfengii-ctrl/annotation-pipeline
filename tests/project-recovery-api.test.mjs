import test from 'node:test';
import { runtimeRecoveryCandidate } from '../lib/runtime-recovery.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { serializeTask, parseTask } from '../lib/task-storage.mjs';
import { projectRecoveryVersion } from '../lib/project-recovery.mjs';
import { rules, candidateDigest } from '../lib/task-policy.mjs';
import { questionRules } from '../lib/question-writing.mjs';
import fixture from './fixtures/question.cjs';
import {
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { permissionAuditVersion } from '../lib/permission-audit.mjs';
import { operationsVersion } from '../lib/operations-status.mjs';

test('real claim/finish routes reserve one recovery and append one audited independent question without altering the old record', async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'project-recovery-api-'));
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE tasks(id TEXT PRIMARY KEY,data TEXT,revision INTEGER DEFAULT 0,created_at TEXT)',
  );
  db.exec('CREATE TABLE runners(id TEXT PRIMARY KEY,data TEXT,heartbeat TEXT)');
  const config = {
    enabled: true,
    autoContinue: true,
    concurrency: 3,
    repos: ['/tmp/fixture'],
    useHistory: true,
    dailyLimit: 20,
  };
  globalThis.__projectRecoveryApi = { db, config, serializeTask, parseTask };
  t.after(() => {
    db.close();
    delete globalThis.__projectRecoveryApi;
    rmSync(tmp, { recursive: true, force: true });
  });
  const repo = process.cwd(),
    out = path.join(tmp, 'api.mjs');
  await build({
    stdin: {
      contents: `export { POST } from './app/api/runner/route.ts'; export { PATCH } from './app/api/tasks/[id]/route.ts'; export {GET as operations} from './app/api/operations/route.ts'; export {GET as source} from './app/api/operations/source/route.ts';`,
      resolveDir: repo,
      loader: 'ts',
    },
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-db',
        setup(b) {
          b.onResolve({ filter: /^@\/db\/(store|scheduler)$/ }, (a) => ({
            path: a.path,
            namespace: 'test-db',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test-db' }, (a) => ({
            loader: 'js',
            contents: a.path.endsWith('scheduler')
              ? `export async function schedulerConfig(){return globalThis.__projectRecoveryApi.config}`
              : `const s=()=>globalThis.__projectRecoveryApi;
export function db(){return {prepare(sql){let args=[];return {bind(...v){args=v;return this},async run(){return {meta:{changes:s().db.prepare(sql).run(...args).changes}}},async first(){return s().db.prepare(sql).get(...args)},async all(){return {results:s().db.prepare(sql).all(...args)}}}}}}
export async function all(){return s().db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all().map(r=>({...s().parseTask(r.data),revision:r.revision}))}
export async function get(id){const r=s().db.prepare('SELECT * FROM tasks WHERE id=?').get(id);return r?{task:s().parseTask(r.data),revision:r.revision}:null}
export async function save(task,rev){if(s().db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=? AND revision=?').run(s().serializeTask(task),task.id,rev).changes!==1)throw Error('revision conflict')}
export function failure(e,status=400){return Response.json({error:e.message},{status})}export function protect(){}export function runnerAuth(){}export function text(v){if(typeof v!=='string'||!v.trim())throw Error('invalid');return v.trim()}`,
          }));
          b.onResolve({ filter: /^@\// }, (a) => {
            const file = path.join(repo, a.path.slice(2));
            return {
              path: [file, file + '.ts', file + '.mjs'].find(existsSync),
            };
          });
        },
      },
    ],
  });
  const routes = await import(pathToFileURL(out));
  const post = (body) =>
    routes.POST(
      new Request('http://localhost/api/runner', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  const current = () =>
    parseTask(
      db.prepare('SELECT data FROM tasks WHERE id=?').get('project').data,
    );
  const original = {
    id: 'failed',
    questionRootId: 'failed',
    category: '0-1 代码生成',
    prompt: '失败草稿原文',
    status: 'failed',
    stage: 'policy',
    excluded: true,
    error: '实质重复',
    output: '原始输出',
    finishedAt: '2026-09-10T00:00:00Z',
    automation: { policy: { accepted: false, value: { reason: '重复流程' } } },
  };
  const task = {
    id: 'project',
    title: '项目保留',
    repoPath: '/tmp/fixture',
    closed: false,
    projectSeries: {
      directory: 'projects/p-00000000-0000-0000-0000-000000000001',
    },
    turns: [original],
  };
  db.prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)').run(
    task.id,
    serializeTask(task),
    '2026-09-10',
  );
  config.acceptingJobs = false;
  config.drainingTurns = ['other:failed'];
  assert.equal((await (await post({ action: 'claim', capacity: 3 })).json()).job, null);
  assert.equal(current().turns[0].status, 'failed');
  config.acceptingJobs = true;
  db.prepare("INSERT INTO runners(id,data,heartbeat) VALUES('scheduler',?,?)")
    .run(JSON.stringify({ acceptingJobs: false }), 'now');
  assert.equal((await (await post({ action: 'claim', capacity: 3 })).json()).job, null);
  db.prepare("DELETE FROM runners WHERE id='scheduler'").run();
  config.acceptingJobs = false;
  config.drainingTurns = ['project:failed'];
  db.prepare("INSERT INTO runners(id,data,heartbeat) VALUES('scheduler',?,?)")
    .run(JSON.stringify({ acceptingJobs: false, drainingTurns: ['project:failed'] }), 'now');
  const claims = await Promise.all(
    Array.from({ length: 5 }, () =>
      post({ action: 'claim', capacity: 3, allowNewContainer: false }),
    ),
  );
  const jobs = (await Promise.all(claims.map((r) => r.json())))
    .map((r) => r.job)
    .filter(Boolean);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  config.acceptingJobs = true;
  config.drainingTurns = [];
  db.prepare("DELETE FROM runners WHERE id='scheduler'").run();
  assert.equal(job.turn.projectRetry.originalStatus, 'failed');
  assert.equal(current().turns.length, 1);
  const c = {
    repoPath: '/fixture/project/failed.replan-source/workspace',
    title: task.title,
    category: '0-1 代码生成',
    difficulty: '中等',
    prompt: fixture.question('独立新功能'),
  };
  const audit = {
    engine: 'codex-cli',
    threadId: 'audit',
    tracePath: '/fixture/policy',
    ruleVersion: rules.version,
    questionRuleVersion: questionRules.version,
    candidateDigest: await candidateDigest(c),
    value: {
      ...fixture.questionAudit,
      allowed: true,
      matchedRuleIds: [],
      duplicateTaskIds: [],
      checkedGroups: rules.groups.map((g) => g.id),
      reason: '合规',
      simpleFeatures: [],
      difficultyEvidence: ['scope', 'context', 'interaction', 'breadth'],
      assessedDifficulty: '中等',
      followupFix: false,
      followupReason: '全新功能',
    },
  };
  const finish = {
    action: 'finish',
    taskId: task.id,
    turnId: original.id,
    jobToken: job.turn.jobToken,
    success: false,
    projectRecovery: {
      version: projectRecoveryVersion,
      turnId: original.id,
      attempts: 1,
      state: 'planned',
      idleVerified: true,
      sourceSnapshot: {
        verified: true,
        manifestPath: '/fixture/project/failed.replan-source/manifest.json',
        manifestSha256: 'a'.repeat(64),
      },
      candidate: c,
      audit,
    },
  };
  config.acceptingJobs = false;
  const saved = await post(finish);
  config.acceptingJobs = true;
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(current().closed, false);
  assert.equal(current().turns.length, 2);
  const [kept, next] = current().turns;
  for (const key of Object.keys(original))
    assert.deepEqual(kept[key], original[key], key);
  assert.equal(next.questionRootId, next.id);
  assert.equal(next.projectSource.turnId, kept.id);
  assert.equal(next.repairOf, undefined);
  assert.equal(kept.projectRecovery.nextTurnId, next.id);
  assert.equal((await post(finish)).status, 200);
  assert.equal(
    current().turns.length,
    2,
    'duplicate finish must not generate another question',
  );
  const continuation = (
    await (await post({ action: 'claim', capacity: 3 })).json()
  ).job;
  assert.equal(
    continuation.turn.id,
    next.id,
    'a verified same-project continuation must be claimable',
  );

  // A planner crash restores the original record; it never clears native IDs.
  const later = {
    ...original,
    id: 'later',
    questionRootId: 'later',
    excluded: false,
    stage: 'claude',
    sessionId: 'native-session',
    promptId: 'native-prompt',
    executionOutcome: 'error',
    traceExport: { verified: true },
    review: { source: 'codex', scores: [1, 2, 3, 4, 5] },
  };
  task.turns = [later];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const second = await (await post({ action: 'claim', capacity: 3 })).json();
  assert.ok(second.job);
  const failed = await post({
    action: 'finish',
    taskId: task.id,
    turnId: later.id,
    jobToken: second.job.turn.jobToken,
    success: false,
    error: 'planner crashed',
  });
  assert.equal(failed.status, 200);
  const restored = current().turns[0];
  assert.equal(restored.status, 'failed');
  assert.equal(restored.stage, 'claude');
  assert.equal(restored.promptId, 'native-prompt');
  assert.equal(restored.sessionId, 'native-session');
  assert.deepEqual(restored.review, later.review);
  assert.equal(
    (await (await post({ action: 'claim', capacity: 3 })).json()).job,
    null,
    'backoff prevents an immediate retry loop',
  );
  const postprocess = {
    ...later,
    executionOutcome: 'complete',
    stage: 'runtime-plan',
    tracePath: '/original.jsonl',
    permissionAudit: { passed: true },
  };
  task.turns = [postprocess];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const stageJob = (await (await post({ action: 'claim', capacity: 3 })).json())
    .job;
  assert.equal(stageJob.turn.stageRecovery.originalStage, 'runtime-plan');
  const earlyFailure = await post({
    action: 'finish',
    taskId: task.id,
    turnId: postprocess.id,
    jobToken: stageJob.turn.jobToken,
    success: false,
    stage: 'policy',
    error: 'audit interrupted before collecting cached Claude fields',
  });
  assert.equal(earlyFailure.status, 200);
  const retained = current().turns[0];
  for (const key of [
    'sessionId',
    'promptId',
    'tracePath',
    'traceExport',
    'permissionAudit',
    'output',
    'finishedAt',
  ])
    assert.deepEqual(retained[key], postprocess[key], key);
  assert.equal(retained.stageRecovery.originalStage, 'runtime-plan');
  const revision = db
    .prepare('SELECT revision FROM tasks WHERE id=?')
    .get(task.id).revision;
  const manualRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'retry', turnId: retained.id, revision }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(manualRetry.status, 200);
  assert.equal(current().turns[0].stageRecovery.attempts, 2);
  assert.equal(current().turns[0].stageRecovery.retrying, true);
  const blocked = {
    ...retained,
    error: '原验收失败',
    projectRecovery: {
      version: projectRecoveryVersion,
      turnId: retained.id,
      state: 'blocked',
      attempts: 3,
      reason: '只读源码访问方式错误',
      retryAt: '2999-01-01T00:00:00Z',
    },
  };
  task.turns = [blocked];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const blockedRevision = db
    .prepare('SELECT revision FROM tasks WHERE id=?')
    .get(task.id).revision;
  const plannerRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: blocked.id,
        revision: blockedRevision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(plannerRetry.status, 200);
  assert.deepEqual(current().turns[0].projectRetry, {
    originalStatus: 'failed',
    originalStage: blocked.stage,
  });
  assert.deepEqual(current().turns[0].projectRecovery, blocked.projectRecovery);
  assert.deepEqual(current().turns[0].stageRecovery, blocked.stageRecovery);
  assert.equal(current().turns[0].error, blocked.error);
  const plannerClaim = await (
    await post({
      action: 'claim',
      runnerId: 'fixture',
      allowNewContainer: false,
    })
  ).json();
  assert.equal(plannerClaim.job.turn.id, blocked.id);
  assert.equal(plannerClaim.job.turn.projectRetry.originalStatus, 'failed');
  const reviewed = {
    ...blocked,
    status: 'review',
    stage: 'delivery',
    excluded: false,
    receipt: undefined,
    executionOutcome: 'complete',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
    automation: {
      ...blocked.automation,
      archive: { verified: true },
      runtimeRecovery: { paused: true, retryAt: '2999-01-01T00:00:00Z' },
    },
  };
  task.turns = [reviewed];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const reviewRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: reviewed.id,
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(reviewRetry.status, 200, await reviewRetry.text());
  const reviewClaim = await (
    await post({
      action: 'claim',
      runnerId: 'fixture',
      allowNewContainer: false,
    })
  ).json();
  assert.equal(reviewClaim.job.turn.projectRetry.originalStatus, 'review');
  assert.equal(reviewClaim.job.turn.id, reviewed.id);
  // Restore the original queued planner fixture for the remaining route checks.
  task.turns = [
    {
      ...blocked,
      status: 'queued',
      projectRetry: { originalStatus: 'failed', originalStage: blocked.stage },
    },
  ];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const beforeRepairDraftTask = current();
  const repairDraft = {
    id: 'unsent-repair',
    category: 'Bug 修复',
    repairOf: 'completed-native',
    questionRootId: 'native-root',
    prompt: '尚未发送的修复题原文',
    status: 'failed',
    stage: 'prepare',
    error: '正文 262 字',
    projectRecovery: { ...blocked.projectRecovery, turnId: 'unsent-repair' },
  };
  const priorNative = {
    id: 'completed-native',
    status: 'review',
    stage: 'project-next',
    sessionId: 'original-session',
    promptId: 'original-message',
    claudeAttempts: ['original-call'],
    executionOutcome: 'complete',
  };
  task.turns = [priorNative, repairDraft];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const draftRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: repairDraft.id,
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(draftRetry.status, 200);
  assert.equal(current().turns[1].status, 'queued');
  assert.equal(current().turns[1].projectRetry, undefined);
  assert.equal(current().turns[1].prompt, repairDraft.prompt);
  assert.equal(current().turns[1].sessionId, undefined);
  assert.deepEqual(
    current().turns[1].projectRecovery,
    repairDraft.projectRecovery,
  );
  assert.deepEqual(current().turns[0], priorNative);
  const repairJob = (
    await (await post({ action: 'claim', capacity: 3 })).json()
  ).job;
  assert.equal(repairJob.turn.id, repairDraft.id);
  assert.equal(repairJob.turn.projectRetry, undefined);
  assert.equal(repairJob.turn.claudeAttempts, undefined);
  // A removed, archived native conversation routes an unsent Bug to planning
  // a distinct project goal, never through the ordinary Claude execution path.
  const closedDraft = {
    ...repairDraft,
    stage: 'context',
    projectRecovery: undefined,
  };
  const archivedParent = {
    ...priorNative,
    questionRootId: 'native-root',
    permissionAudit: { passed: true },
    traceExport: { verified: true },
    automation: { archive: { manifestSha256: 'a'.repeat(64) } },
  };
  task.container = {
    status: 'removed',
    questionId: 'native-root',
    sessionId: 'original-session',
    traceExport: { verified: true },
    terminal: { runId: 'run' },
    terminalFinalization: { runId: 'run', completedAt: '2026-09-12T00:00:00Z' },
  };
  task.turns = [archivedParent, closedDraft];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const closedClaim = await (
    await post({ action: 'claim', capacity: 3, allowNewContainer: false })
  ).json();
  assert.equal(closedClaim.job.turn.projectRetry.originalStage, 'context');
  assert.equal(closedClaim.job.turn.claudeAttempts, undefined);
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const closedRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: closedDraft.id,
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(closedRetry.status, 200);
  assert.equal(current().turns[1].projectRetry.originalStage, 'context');
  delete task.container;
  const independentDraft = {
    ...repairDraft,
    repairOf: undefined,
    category: '代码理解',
    error: '表达修订不得改动 prepare.acceptance',
  };
  task.turns = [priorNative, independentDraft];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const independentRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: independentDraft.id,
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(independentRetry.status, 200);
  assert.equal(current().turns[1].projectRetry, undefined);
  assert.equal(current().turns[1].category, '代码理解');
  assert.equal(current().turns[1].prompt, independentDraft.prompt);
  assert.deepEqual(current().turns[0], priorNative);
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(beforeRepairDraftTask),
    task.id,
  );
  const manualPlanJob = (
    await (await post({ action: 'claim', capacity: 3 })).json()
  ).job;
  assert.ok(manualPlanJob.turn.projectRetry);
  const forbiddenClaude = await post({
    action: 'reserve-claude',
    taskId: task.id,
    turnId: blocked.id,
    jobToken: manualPlanJob.turn.jobToken,
    attemptId: 'must-not-send',
    sessionId: 'native-session',
  });
  assert.notEqual(forbiddenClaude.status, 200);
  const manualPlanFailure = await post({
    action: 'finish',
    taskId: task.id,
    turnId: blocked.id,
    jobToken: manualPlanJob.turn.jobToken,
    success: false,
    error: 'new planning obstacle',
  });
  assert.equal(manualPlanFailure.status, 200);
  assert.equal(current().turns[0].projectRecovery.attempts, 4);
  assert.equal(current().turns[0].error, blocked.error);
  for (const key of [
    'sessionId',
    'promptId',
    'tracePath',
    'traceExport',
    'review',
    'stageRecovery',
  ])
    assert.deepEqual(current().turns[0][key], blocked[key], key);
  assert.equal(
    (await (await post({ action: 'claim', capacity: 3 })).json()).job,
    null,
    'explicit retry does not reset the automatic retry budget',
  );
  const validationRevision = db
    .prepare('SELECT revision FROM tasks WHERE id=?')
    .get(task.id).revision;
  const validationRequest = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry-validation',
        turnId: blocked.id,
        revision: validationRevision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(validationRequest.status, 200);
  assert.equal(current().turns[0].projectRetry, undefined);
  assert.equal(current().turns[0].stageRecovery.validationOnly, true);
  assert.equal(current().turns[0].projectRecovery.attempts, 4);
  const resident = {
    ...task,
    id: 'resident',
    turns: [{ id: 'resident-new', status: 'queued', prompt: 'next' }],
  };
  db.prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)').run(
    resident.id,
    serializeTask(resident),
    '2026-09-09',
  );
  const validationJob = (
    await (
      await post({
        action: 'claim',
        capacity: 3,
        allowNewContainer: false,
        residentTaskIds: ['resident'],
      })
    ).json()
  ).job;
  assert.equal(
    validationJob.task.id,
    task.id,
    'completed verification precedes resident new work without requiring another Claude container',
  );
  assert.ok(validationJob.turn.stageRecovery.validationOnly);
  db.prepare('DELETE FROM tasks WHERE id=?').run(resident.id);
  const deniedValidationSend = await post({
    action: 'reserve-claude',
    taskId: task.id,
    turnId: blocked.id,
    jobToken: validationJob.turn.jobToken,
    attemptId: 'must-not-send',
    sessionId: 'native-session',
  });
  assert.notEqual(deniedValidationSend.status, 200);
  for (const key of [
    'sessionId',
    'promptId',
    'tracePath',
    'traceExport',
    'review',
  ])
    assert.deepEqual(current().turns[0][key], blocked[key]);
  const originalCount = current().turns.length;
  const timeoutRecovery = runtimeRecoveryCandidate({
    plan: { path: '/fixture/runtime-plan', sha256: 'a'.repeat(64) },
    progress: { completedIds: ['first'], producedOutput: true },
    stage: 'runtime-running',
    turnId: blocked.id,
    error: 'timeout',
  });
  const timeoutFinish = {
    action: 'finish',
    taskId: task.id,
    turnId: blocked.id,
    jobToken: validationJob.turn.jobToken,
    success: false,
    stage: 'runtime-running',
    error: 'timeout',
    executionOutcome: 'complete',
    sessionId: blocked.sessionId,
    promptId: blocked.promptId,
    tracePath: blocked.tracePath,
    automation: { runtimeRecovery: timeoutRecovery },
  };
  const savedTimeout = await post(timeoutFinish);
  assert.equal(savedTimeout.status, 200, await savedTimeout.clone().text());
  assert.equal(current().turns[0].status, 'queued');
  assert.equal(current().turns.length, originalCount);
  assert.equal(current().turns[0].stageRecovery.validationOnly, true);
  assert.equal(current().turns[0].promptId, blocked.promptId);
  assert.equal(
    (await (await post({ action: 'claim', capacity: 3 })).json()).job,
    null,
    'wait until retry due',
  );
  const pending = current();
  pending.turns[0].automation.runtimeRecovery.retryAt = '2000-01-01T00:00:00Z';
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(pending),
    task.id,
  );
  const resumedJob = (
    await (
      await post({ action: 'claim', capacity: 3, allowNewContainer: false })
    ).json()
  ).job;
  assert.equal(resumedJob.turn.id, blocked.id);
  assert.equal(resumedJob.turn.stageRecovery.validationOnly, true);
  assert.notEqual(
    (
      await post({
        action: 'reserve-claude',
        taskId: task.id,
        turnId: blocked.id,
        jobToken: resumedJob.turn.jobToken,
        attemptId: 'no-extra-model-call',
        sessionId: blocked.sessionId,
      })
    ).status,
    200,
  );
  const pausedFinish = await post({
    ...timeoutFinish,
    jobToken: resumedJob.turn.jobToken,
    automation: { runtimeRecovery: { ...timeoutRecovery, state: 'paused' } },
  });
  assert.equal(pausedFinish.status, 200);
  assert.equal(current().turns[0].status, 'queued');
  assert.equal(
    (await (await post({ action: 'claim', capacity: 3 })).json()).job,
    null,
    'paused recovery cannot spin indefinitely',
  );
  // A historical postprocessor queues behind current work, then writes only
  // its old Turn. It cannot resurrect the old task container or append a Bug.
  const historyId = '11111111-1111-1111-1111-111111111111';
  const historyContainer = {
    policyVersion: containerPolicyVersion,
    taskId: task.id,
    questionId: historyId,
    name: 'annotation-' + task.id,
    status: 'removed',
    containerId: 'old-container',
    workDir: '/old/workspace',
    snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
    terminalIdentity: {
      transport: 'mac-terminal',
      realTerminal: true,
      tty: '/dev/old',
      runId: 'old-terminal',
    },
  };
  const historyTurn = {
    ...blocked,
    id: historyId,
    questionRootId: historyId,
    status: 'failed',
    container: historyContainer,
    traceExport: { verified: true, sha256: 'b'.repeat(64) },
    permissionAudit: {
      version: permissionAuditVersion,
      passed: true,
      modeVerified: true,
      denialCount: 0,
      traceSha256: 'b'.repeat(64),
    },
    projectRecovery: {
      ...blocked.projectRecovery,
      state: 'continued',
      nextTurnId: 'current',
    },
  };
  const newest = {
    id: 'current',
    status: 'running',
    prompt: '当前题目',
    sessionId: 'current-session',
    jobToken: 'current-job',
  };
  const liveContainer = {
    ...historyContainer,
    status: 'running',
    containerId: 'current-container',
    questionId: '22222222-2222-2222-2222-222222222222',
    workDir: '/current/workspace',
  };
  const historyTask = {
    ...task,
    turns: [historyTurn, newest],
    container: liveContainer,
    workDir: '/current/workspace',
    sessionId: 'current-session',
    model: 'configured-model',
    automationMode: 'codex',
  };
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(historyTask),
    task.id,
  );
  const hr = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry-validation',
        turnId: historyId,
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(hr.status, 200, await hr.clone().text());
  assert.equal(current().turns[0].stageRecovery.historical, true);
  assert.equal(
    (
      await (
        await post({ action: 'claim', capacity: 3, allowNewContainer: false })
      ).json()
    ).job,
    null,
    'do not interrupt current execution',
  );
  const waiting = current();
  waiting.turns[1].status = 'queued';
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(waiting),
    task.id,
  );
  const hj = (
    await (
      await post({ action: 'claim', capacity: 3, allowNewContainer: false })
    ).json()
  ).job;
  assert.equal(hj.turn.id, historyId);
  const liveBeforeFinish = current();
  const historyFinish = {
    action: 'finish',
    taskId: task.id,
    turnId: historyId,
    jobToken: hj.turn.jobToken,
    success: true,
    projectRecovery: structuredClone(historyTurn.projectRecovery),
    container: historyContainer,
    traceExport: historyTurn.traceExport,
    permissionAudit: historyTurn.permissionAudit,
    sessionId: historyTurn.sessionId,
    promptId: historyTurn.promptId,
    tracePath: historyTurn.tracePath,
    finishedAt: historyTurn.finishedAt,
    executionOutcome: 'complete',
    preparedPrompt: historyTurn.prompt,
    workDir: '/old/workspace',
    model: 'old-model',
    preparation: {
      category: 'Feature 迭代',
      difficulty: '困难',
      stack: 'old-stack',
    },
    review: {
      source: 'codex',
      scores: [3, 4, 4, 4, 4],
      descriptions: Array(5).fill('本轮实际结果'),
      other: '无',
    },
    automation: {
      delivery: { value: { passed: true } },
      next: { value: { action: 'repair', prompt: '不得追加旧会话修复' } },
    },
  };
  assert.notEqual(
    (await post({ ...historyFinish, sessionId: 'wrong-session' })).status,
    200,
  );
  assert.notEqual(
    (
      await post({
        ...historyFinish,
        projectRecovery: {
          ...historyTurn.projectRecovery,
          nextTurnId: 'new-question',
        },
      })
    ).status,
    200,
    'historical context must not authorize a new project recovery',
  );
  const failedHistory = await post({
    ...historyFinish,
    success: false,
    error: '验收脚本定位错误',
  });
  assert.equal(failedHistory.status, 200, await failedHistory.clone().text());
  assert.equal(current().turns[0].status, 'failed');
  assert.equal(current().turns[0].jobToken, undefined);
  assert.equal(current().turns[0].stageRecovery.retrying, false);
  assert.deepEqual(
    current().turns[0].projectRecovery,
    historyTurn.projectRecovery,
  );
  assert.deepEqual(current().turns[1], liveBeforeFinish.turns[1]);
  assert.equal(current().turns.length, 2);
  // Independently verify the successful result path from the same claimed state.
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(liveBeforeFinish),
    task.id,
  );
  const historySaved = await post(historyFinish);
  assert.equal(historySaved.status, 200, await historySaved.clone().text());
  const { turns: oldTurns, ...oldMetadata } = liveBeforeFinish,
    { turns: newTurns, ...newMetadata } = current();
  assert.deepEqual(
    newMetadata,
    oldMetadata,
    'current project metadata must remain identical',
  );
  assert.deepEqual(
    newTurns[1],
    oldTurns[1],
    'current question must remain identical',
  );
  assert.equal(
    newTurns.length,
    2,
    'historical verification must not append a new Bug',
  );
  assert.equal(newTurns[0].status, 'review');
  assert.deepEqual(newTurns[0].review.scores, [3, 4, 4, 4, 4]);
  assert.equal(
    (await post(historyFinish)).status,
    200,
    'repeated completion remains idempotent',
  );
  // Finish this fixture before exercising unrelated project admission quotas.
  task.turns = [retained];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const proposal = async (fingerprint) => {
    const c = {
      repoPath: '/tmp/fixture',
      title: '新项目' + fingerprint[0],
      prompt: fixture.question('新项目' + fingerprint[0]),
      category: '0-1 代码生成',
      difficulty: '中等',
      stack: 'Node.js',
      tracePath: '/fixture/generate',
      projectSeries: {
        version: '2026-09-09.project2',
        directory: 'projects/p-00000000-0000-0000-0000-000000000002',
      },
    };
    return post({
      action: 'enqueue-auto',
      ...c,
      fingerprint,
      policyAudit: { ...audit, candidateDigest: await candidateDigest(c) },
    });
  };
  const raced = await Promise.all([
    proposal('1'.repeat(64)),
    proposal('2'.repeat(64)),
  ]);
  const outcomes = await Promise.all(raced.map((r) => r.json()));
  assert.equal(
    outcomes.filter((r) => r.taskId).length,
    1,
    JSON.stringify(outcomes),
  );
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 2);
  const third = await (await proposal('3'.repeat(64))).json();
  assert.ok(third.taskId, JSON.stringify(third));
  assert.match(
    (await (await proposal('4'.repeat(64))).json()).skipped,
    /原项目续题/,
  );
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n, 3);

  task.turns = ['0-1 代码生成', 'Feature 迭代'].flatMap((category, i) =>
    Array.from({ length: 10 }, (_, n) => ({
      ...original,
      id: `quota-${i}-${n}`,
      category,
      excluded: false,
      claudeAttempts: ['sent'],
    })),
  );
  const last = task.turns.at(-1);
  last.status = 'running';
  last.jobToken = 'quota';
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const quotaEnd = await post({
    action: 'finish',
    taskId: task.id,
    turnId: last.id,
    jobToken: 'quota',
    success: false,
    error: '原生已结束的调用失败',
  });
  assert.equal(quotaEnd.status, 200);
  assert.equal(
    current().closed,
    true,
    'only both actual-sent quotas permit automatic project closure',
  );
  db.exec('DELETE FROM tasks');
  for (let i = 0; i < 3; i++) {
    const established = {
      ...task,
      id: 'existing-' + i,
      closed: false,
      turns: [
        {
          ...original,
          claudeAttempts: ['sent'],
          stage: 'claude',
          executionOutcome: 'truncated',
        },
      ],
    };
    db.prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)').run(
      established.id,
      serializeTask(established),
      '2026-09-09',
    );
  }
  const backlog = {
    ...task,
    id: 'backlog',
    closed: false,
    turns: [
      {
        ...original,
        id: 'first',
        excluded: false,
        status: 'queued',
        stage: undefined,
      },
    ],
  };
  db.prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)').run(
    backlog.id,
    serializeTask(backlog),
    '2026-09-10',
  );
  assert.equal(
    (await (await post({ action: 'claim', capacity: 3 })).json()).job,
    null,
    'an old queued new project cannot bypass existing unfinished project slots',
  );
  const report = {
    version: operationsVersion,
    checkedAt: new Date().toISOString(),
    projects: [{ taskId: 'project', status: 'repairing', next: '等待验证' }],
  };
  assert.equal(
    (await post({ action: 'operations', value: report })).status,
    200,
  );
  assert.deepEqual(
    (await (await routes.operations()).json()).operations,
    report,
  );
  assert.equal(
    (
      await post({
        action: 'operations',
        value: { ...report, checkedAt: 'bad' },
      })
    ).status,
    400,
  );
  const statsTask = {
    ...task,
    id: 'statistics',
    closed: true,
    turns: [
      {
        id: 'stat-turn',
        status: 'running',
        stage: 'delivery',
        jobToken: 'stat-job',
        prompt: '原题',
        questionRootId: 'stat-turn',
      },
    ],
  };
  db.prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)').run(
    statsTask.id,
    serializeTask(statsTask),
    '2026-09-12',
  );
  const result = {
    action: 'finish',
    taskId: statsTask.id,
    turnId: 'stat-turn',
    jobToken: 'stat-job',
    success: true,
    automation: { delivery: { value: { passed: true } } },
  };
  assert.equal((await post(result)).status, 200);
  assert.equal((await post(result)).status, 200); // lost HTTP acknowledgement
  let savedStats = parseTask(
    db.prepare('SELECT data FROM tasks WHERE id=?').get('statistics').data,
  );
  assert.deepEqual(
    savedStats.turns[0].productionHistory.events.map((e) => e.kind),
    ['first-delivery'],
  );
  Object.assign(savedStats.turns[0], {
    status: 'running',
    jobToken: 'revalidation-job',
  });
  db.prepare('UPDATE tasks SET data=? WHERE id=?').run(
    serializeTask(savedStats),
    'statistics',
  );
  assert.equal(
    (await post({ ...result, jobToken: 'revalidation-job' })).status,
    200,
  );
  savedStats = parseTask(
    db.prepare('SELECT data FROM tasks WHERE id=?').get('statistics').data,
  );
  assert.deepEqual(
    savedStats.turns[0].productionHistory.events.map((e) => e.kind),
    ['first-delivery', 'revalidation'],
  );
  assert.equal(savedStats.turns[0].productionHistory.revalidationCount, 1);
  const compact = (await (await routes.source()).json()).tasks;
  assert.ok(
    compact.every((t) =>
      t.turns.every((r) => r.jobToken === undefined && r.prompt === undefined),
    ),
  );
  task.closed = false;
  task.container = {
    status: 'running',
    containerId: 'container',
    questionId: 'observed',
    terminal: { runId: 'terminal' },
  };
  task.turns = [
    {
      id: 'observed',
      questionRootId: 'observed',
      status: 'running',
      stage: 'claude',
      jobToken: 'old-token',
      category: '0-1 代码生成',
      claudeAttempts: ['sent-once'],
      prompt: '原题保持不变',
    },
  ];
  db.prepare(
    'INSERT OR REPLACE INTO tasks(id,data,created_at) VALUES(?,?,?)',
  ).run(task.id, serializeTask(task), '2026-09-12');
  const handoff = {
    action: 'handoff-observer',
    taskId: task.id,
    turnId: 'observed',
    jobToken: 'old-token',
    containerId: 'container',
    sessionId: null,
    terminalRunId: 'terminal',
    promptHash: 'a'.repeat(64),
  };
  assert.equal((await post({ ...handoff, containerId: 'other' })).status, 400);
  const handed = await post(handoff);
  assert.equal(handed.status, 200, await handed.text());
  const queued = current();
  assert.equal(queued.turns[0].status, 'queued');
  assert.deepEqual(queued.turns[0].claudeAttempts, ['sent-once']);
  assert.equal(queued.turns[0].prompt, '原题保持不变');
  assert.equal(JSON.stringify(queued).includes('old-token'), false);
  assert.equal((await post(handoff)).status, 200);
  assert.equal(
    (
      await post({
        ...handoff,
        action: 'finish',
        result: { success: false, error: 'old observer stopped' },
      })
    ).status,
    200,
  );
  assert.equal(current().turns[0].status, 'queued');
  assert.equal((await post({ ...handoff, action: 'recover' })).status, 200);
  const resumed = await (
    await post({ action: 'claim', runnerId: 'fixture' })
  ).json();
  assert.equal(resumed.job.turn.id, 'observed');
  assert.notEqual(resumed.job.turn.jobToken, 'old-token');
  assert.equal(
    (
      await post({
        action: 'reserve-claude',
        taskId: task.id,
        turnId: 'observed',
        jobToken: resumed.job.turn.jobToken,
      })
    ).status,
    400,
  );
  assert.deepEqual(current().turns[0].claudeAttempts, ['sent-once']);
  assert.equal(resumed.job.turn.observerHandoff.promptHash, handoff.promptHash);
  await post({ ...handoff, action: 'finish', result: { success: false } });
  assert.equal(current().turns[0].jobToken, resumed.job.turn.jobToken);
  task.turns = [
    {
      id: 'stopped',
      questionRootId: 'stopped',
      status: 'failed',
      stage: 'context',
      claudeAttempts: ['sent'],
      error: '此题容器已停止，只能导出归档，不能重启旧任务',
    },
  ];
  task.container = {
    containerId: 'stopped-container',
    questionId: 'stopped',
    status: 'running',
  };
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const stopRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry',
        turnId: 'stopped',
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(stopRetry.status, 200);
  assert.equal(
    current().turns[0].stoppedCompletionRecovery.containerId,
    'stopped-container',
  );
  assert.equal(current().turns[0].projectRetry, undefined);
  assert.deepEqual(current().turns[0].claudeAttempts, ['sent']);
  const stoppedClaim = await (
    await post({ action: 'claim', allowNewContainer: false })
  ).json();
  assert.equal(
    stoppedClaim.job?.turn.id,
    'stopped',
    'reading an already stopped container needs no new business container',
  );
  const oldRuntime = runtimeRecoveryCandidate({
    turnId: 'validation',
    stage: 'runtime-diagnose',
    error: 'old verifier timeout',
    plan: { path: '/fixture-plan', sha256: 'a'.repeat(64) },
    now: 1000,
  });
  task.turns = [
    {
      id: 'validation',
      status: 'failed',
      stage: 'delivery',
      executionOutcome: 'complete',
      promptId: 'native',
      sessionId: 'session',
      traceExport: { verified: true },
      permissionAudit: { passed: true },
      automation: { runtimeRecovery: oldRuntime },
    },
  ];
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    serializeTask(task),
    task.id,
  );
  const validationRetry = await routes.PATCH(
    new Request('http://localhost/api/tasks/project', {
      method: 'PATCH',
      body: JSON.stringify({
        action: 'retry-validation',
        turnId: 'validation',
        revision: db
          .prepare('SELECT revision FROM tasks WHERE id=?')
          .get(task.id).revision,
      }),
    }),
    { params: Promise.resolve({ id: task.id }) },
  );
  assert.equal(validationRetry.status, 200);
  const validationClaim = await (
    await post({ action: 'claim', allowNewContainer: false })
  ).json();
  assert.equal(
    validationClaim.job?.turn.id,
    'validation',
    'explicit validation retry must not be blocked by its later delivery stage',
  );
  assert.equal(validationClaim.job.turn.stage, 'delivery');
});
