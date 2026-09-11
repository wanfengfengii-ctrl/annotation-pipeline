import test from 'node:test';
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
      contents: `export { POST } from './app/api/runner/route.ts'; export { PATCH } from './app/api/tasks/[id]/route.ts';`,
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
  const saved = await post(finish);
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
  const validationJob = (
    await (await post({ action: 'claim', capacity: 3 })).json()
  ).job;
  assert.ok(validationJob.turn.stageRecovery.validationOnly);
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
});
