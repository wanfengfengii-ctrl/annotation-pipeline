import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  disputedContinuationVersion,
  disputedEvaluationComplete,
  disputeContinuationReady,
  blocksProject,
} from '../lib/disputed-continuation.mjs';
import { canRepair, claudeCallCount } from '../lib/project-series.mjs';
import { priorQuestionTurn } from '../lib/question-session.mjs';
import { runtimeVersion } from '../lib/runtime-verification.mjs';
import fixture from './fixtures/question.cjs';
import {
  retainDisputedSource,
  readDisputedEvaluation,
  planDisputedProject,
} from '../scripts/disputed-project-plan.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';

function example() {
  const first = {
    id: 'first',
    questionRootId: 'first',
    category: '0-1 代码生成',
    status: 'review',
    claudeAttempts: ['a'],
  };
  const turn = {
    id: 'bug',
    questionRootId: 'first',
    repairOf: 'first',
    category: 'Bug 修复',
    difficulty: '中等',
    status: 'failed',
    stage: 'delivery',
    prompt: fixture.repair(),
    roundNumber: 2,
    executionOutcome: 'complete',
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/original.jsonl',
    traceExport: { verified: true, sha256: 'native' },
    permissionAudit: { passed: true },
    claudeAttempts: ['b'],
    review: {
      source: 'codex',
      scores: [5, 4, 4, 4, 3],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
    },
    automation: {
      submittedPolicyEvidence: {
        receipt: {
          sessionId: 'session',
          promptId: 'prompt',
          nativeExportSha256: 'native',
        },
        postExecutionPolicy: [{ disputed: true }],
      },
      delivery: { value: { passed: true } },
      runtimeVersion,
      runtimeVerification: {
        version: runtimeVersion,
        executed: true,
        status: 'bugs',
        reportPath: '/report.json',
        reportSha256: 'report',
        checks: [
          {
            id: 'remaining',
            kind: 'reproduction',
            outcome: 'reproduced',
            exitCode: 1,
            logPath: '/remaining.log',
            logSha256: 'log',
            requirement: 'real defect',
            codeEvidence: 'app.js:1',
          },
        ],
      },
    },
  };
  return {
    id: 'task',
    projectSeries: { directory: 'projects/p-existing' },
    container: { status: 'running', questionId: 'first' },
    turns: [first, turn],
    closed: false,
  };
}
function ready(turn) {
  turn.automation.projectContinuation = {
    version: disputedContinuationVersion,
    state: 'planned',
    turnId: turn.id,
    sessionId: turn.sessionId,
    promptId: turn.promptId,
    runtimeReportSha256: 'report',
    sourceSnapshot: {
      verified: true,
      manifestPath: '/retained/manifest.json',
      manifestSha256: 'manifest',
    },
  };
  return turn;
}
test('failed question code and score citations freeze before another question, and a new container imports those bytes', (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'disputed-source-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = example(),
    previous = ready(task.turns[1]);
  task.id = randomUUID();
  const dir = path.join(root, task.id),
    workDir = path.join(dir, 'old');
  mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, 'app.js');
  writeFileSync(file, 'export const value=1;\n');
  const result = {
    taskId: task.id,
    turnId: previous.id,
    workDir,
    sessionId: previous.sessionId,
    promptId: previous.promptId,
    review: { ...previous.review, evidenceRefs: Array(5).fill(file + ':1') },
    automation: previous.automation,
    preparedPrompt: previous.prompt,
  };
  const snapshot = retainDisputedSource({ dir, turn: previous, result });
  assert.deepEqual(
    retainDisputedSource({ dir, turn: previous, result }),
    snapshot,
  );
  previous.automation.projectContinuation.sourceSnapshot = snapshot;
  writeFileSync(file, 'export const value=2;\n');
  assert.throws(
    () => retainDisputedSource({ dir, turn: previous, result }),
    /代码已变化/,
  );
  const manifest = JSON.parse(readFileSync(snapshot.manifestPath));
  assert.equal(
    readFileSync(
      path.join(
        path.dirname(snapshot.manifestPath),
        manifest.citations[0].name,
      ),
      'utf8',
    ),
    'export const value=1;\n',
  );
  const fresh = {
    id: randomUUID(),
    questionRootId: null,
    category: 'Feature 迭代',
    status: 'queued',
  };
  task.turns.push(fresh);
  const s = {
    taskId: task.id,
    questionId: fresh.id,
    workDir: path.join(dir, 'new'),
    status: 'running',
    results: {},
  };
  mkdirSync(s.workDir);
  const runtime = new DockerRuntime(root);
  runtime.importPriorQuestion(s, task, fresh);
  assert.equal(
    readFileSync(path.join(s.workDir, 'app.js'), 'utf8'),
    'export const value=1;\n',
  );
  assert.equal(s.sourceSnapshot.turnId, previous.id);
  assert.equal(s.sourceSnapshot.importedAfterStartup, true);
  assert.equal(
    existsSync(path.join(dir, previous.id + '.ai-delivery.json')),
    false,
  );
});
test('question rejection can release project planning without approving the failed record or resetting quota', () => {
  const task = example(),
    turn = task.turns[1];
  assert.equal(disputedEvaluationComplete(turn), true);
  assert.equal(blocksProject(turn), true);
  assert.equal(canRepair(task, turn), false);
  ready(turn);
  assert.equal(blocksProject(turn), false);
  assert.equal(canRepair(task, turn), true);
  assert.equal(turn.status, 'failed');
  assert.equal(claudeCallCount(task), 2);
  task.turns.push({
    id: 'third',
    questionRootId: 'first',
    repairOf: turn.id,
    category: 'Bug 修复',
    status: 'review',
    claudeAttempts: ['c'],
  });
  assert.equal(canRepair(task, task.turns[2]), false);
  const fourth = { id: 'fresh', category: 'Feature 迭代', status: 'queued' };
  assert.equal(
    priorQuestionTurn(
      { ...task, turns: [...task.turns.slice(0, 2), fourth] },
      fourth,
    ).id,
    'bug',
  );
});
test('incomplete, mismatched or unretained failures never release the project', () => {
  for (const change of [
    (r) => (r.executionOutcome = 'truncated'),
    (r) => (r.recoveryBlocked = true),
    (r) => (r.permissionAudit.passed = false),
    (r) => (r.promptId = 'different'),
    (r) => (r.traceExport.sha256 = 'different'),
    (r) => (r.automation.delivery.value.passed = false),
    (r) => (r.automation.runtimeVerification.status = 'blocked'),
    (r) => (r.automation.projectContinuation.state = 'blocked'),
    (r) => (r.automation.projectContinuation.sourceSnapshot.verified = false),
    (r) => (r.automation.projectContinuation.runtimeReportSha256 = 'different'),
    (r) => (r.automation.archive = { archivePath: '/unexpected' }),
  ]) {
    const r = ready(example().turns[1]);
    change(r);
    assert.equal(disputeContinuationReady(r), false);
    assert.equal(blocksProject(r), true);
  }
});

test('planning retries preserve evaluation bytes and have exactly one authoritative restart outbox', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'disputed-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const task = example(),
    turn = task.turns[1],
    receipt = path.join(dir, 'bug.result.json');
  const original = Buffer.from(
    JSON.stringify({
      ...turn,
      taskId: task.id,
      turnId: turn.id,
      jobToken: 'old',
    }),
  );
  writeFileSync(receipt, original);
  const api = async () => ({ config: { autoContinue: false } });
  const first = await planDisputedProject({
    task,
    turn: { ...turn, jobToken: 'retry1' },
    cached: {},
    dir,
    api,
  });
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  writeFileSync(receipt + '.delivered', digest(readFileSync(receipt)));
  const second = await planDisputedProject({
    task,
    turn: { ...turn, jobToken: 'retry2' },
    cached: {},
    dir,
    api,
  });
  assert.equal(first.receipt, receipt);
  assert.equal(second.receipt, receipt);
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.endsWith('.result.json')),
    ['bug.result.json'],
  );
  assert.notEqual(
    readFileSync(receipt + '.delivered', 'utf8'),
    digest(readFileSync(receipt)),
    'new token causes canonical replay',
  );
  assert.equal(JSON.parse(readFileSync(receipt)).jobToken, 'retry2');
  assert.equal(readDisputedEvaluation(dir, 'bug').jobToken, 'old');
  assert.deepEqual(
    readFileSync(path.join(dir, 'bug.disputed-evaluation.json')),
    original,
  );
  assert.equal(second.result.success, false);
  assert.equal(second.result.promptId, turn.promptId);
  assert.deepEqual(second.result.review, turn.review);
});

test('malformed original receipt is preserved and planning failure never erases API evidence fields', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'disputed-malformed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const task = example(),
    turn = task.turns[1];
  writeFileSync(path.join(dir, 'bug.result.json'), '{broken');
  const result = await planDisputedProject({
    task,
    turn: { ...turn, jobToken: 'retry' },
    dir,
  });
  assert.equal(
    readFileSync(path.join(dir, 'bug.disputed-evaluation.json'), 'utf8'),
    '{broken',
  );
  assert.equal(result.result.success, false);
  assert.equal(result.result.promptId, turn.promptId);
  assert.deepEqual(result.result.review, turn.review);
  assert.equal(result.result.tracePath, turn.tracePath);
  assert.ok(result.result.automation.nextError);
  assert.equal(result.result.automation.next, undefined);
});

test('actual API routes retry only planning, append one same-session Bug and keep the disputed record nonexportable', async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'disputed-api-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete globalThis.__disputedApi;
  });
  const repo = process.cwd(),
    out = path.join(tmp, 'api.mjs');
  await build({
    stdin: {
      contents: `export { PATCH } from './app/api/tasks/[id]/route.ts'; export { POST } from './app/api/runner/route.ts'; export { issues } from './lib/pipeline.ts';`,
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
        name: 'isolated-store',
        setup(b) {
          b.onResolve({ filter: /^@\/db\/(store|scheduler)$/ }, (a) => ({
            path: a.path,
            namespace: 'fake',
          }));
          b.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({
            contents: a.path.endsWith('scheduler')
              ? `export async function schedulerConfig(){return globalThis.__disputedApi.config}`
              : `const s=()=>globalThis.__disputedApi;export async function get(id){return id===s().task.id?{task:structuredClone(s().task),revision:s().revision}:null}export async function all(){return [{...structuredClone(s().task),revision:s().revision}]}export async function save(task,revision){if(revision!==s().revision)throw Error('数据已更新');s().task=structuredClone(task);s().revision++}export function db(){throw Error('unexpected database action')}export function failure(e,status=400){return Response.json({error:e.message},{status})}export function protect(){}export function runnerAuth(){}export function text(v){if(typeof v!=='string'||!v.trim())throw Error('invalid text');return v.trim()}`,
            loader: 'js',
          }));
          b.onResolve({ filter: /^@\// }, (a) => {
            const p = path.join(repo, a.path.slice(2));
            return { path: [p, p + '.ts', p + '.mjs'].find(existsSync) };
          });
        },
      },
    ],
  });
  const routes = await import(pathToFileURL(out));
  globalThis.__disputedApi = {
    task: example(),
    revision: 1,
    config: { autoContinue: true },
  };
  const s = globalThis.__disputedApi,
    original = structuredClone(s.task.turns[1]);
  const patch = (body) =>
    routes.PATCH(
      new Request('http://localhost/api/tasks/task', {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: 'task' }) },
    );
  const post = (body) =>
    routes.POST(
      new Request('http://localhost/api/runner', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  assert.equal(
    (await patch({ action: 'retry-plan', turnId: 'bug', revision: 1 })).status,
    200,
  );
  assert.equal(s.task.turns[1].status, 'queued');
  assert.equal(s.task.turns[1].planRetry, true);
  assert.equal(
    (await patch({ action: 'retry-plan', turnId: 'bug', revision: 2 })).status,
    400,
  );
  s.task.turns[1].status = 'running';
  s.task.turns[1].jobToken = 'job';
  const result = ready(structuredClone(original));
  result.automation.next = {
    value: {
      action: 'repair',
      category: 'Bug 修复',
      difficulty: '中等',
      prompt: fixture.repair() + ' 保留其他内容。',
      reason: '依据实际复现继续修复',
      projectEvidence: 'app.js:1',
      repairCheckIds: ['remaining'],
      baseComplete: false,
    },
  };
  const finish = {
    ...result,
    action: 'finish',
    taskId: 'task',
    turnId: 'bug',
    jobToken: 'job',
    success: false,
  };
  assert.equal(
    (await post({ ...finish, success: true })).status,
    400,
    'dispute cannot become successful',
  );
  const response = await post(finish);
  assert.equal(response.status, 200, await response.text());
  assert.equal(s.task.turns.length, 3);
  const kept = s.task.turns[1],
    next = s.task.turns[2];
  assert.equal(kept.status, 'failed');
  assert.equal(kept.excluded, undefined);
  assert.deepEqual(kept.review.scores, original.review.scores);
  assert.equal(kept.prompt, original.prompt);
  assert.deepEqual(
    kept.automation.submittedPolicyEvidence,
    original.automation.submittedPolicyEvidence,
  );
  assert.equal(kept.automation.archive, undefined);
  assert.equal(kept.automation.bundlePath, undefined);
  assert.ok(
    routes.issues(s.task, kept).some((e) => e.includes('不可标准导出')),
  );
  assert.equal(next.status, 'queued');
  assert.equal(next.repairOf, 'bug');
  assert.equal(next.questionRootId, 'first');
  assert.equal(next.roundNumber, 3);
  assert.equal(kept.automation.projectContinuation.nextTurnId, next.id);
  assert.equal((await post(finish)).status, 200);
  assert.equal(s.task.turns.length, 3, 'finish replay creates no duplicate');
  assert.equal(
    (await patch({ action: 'retry-plan', turnId: 'bug', revision: s.revision }))
      .status,
    400,
    'historical record cannot be replanned',
  );
});
