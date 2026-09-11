import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import fixture from './fixtures/question.cjs';
import {
  wasSent,
  sentProjectCounts,
  projectQuotaComplete,
  projectRecoveryDue,
  projectRecoveryReady,
  postprocessRetryDue,
} from '../lib/project-recovery.mjs';
import {
  canAddTurn,
  projectCounts,
  seriesVersion,
} from '../lib/project-series.mjs';
import { sessionFinalization } from '../lib/session-finalization.mjs';
import {
  questionHistory,
  goalHistoryInstructions,
} from '../lib/question-history.mjs';
import {
  retainRecoverySource,
  planFailedProject,
} from '../scripts/failed-project-plan.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
import { rules } from '../lib/task-policy.mjs';
import { terminalProtocolVersion } from '../scripts/mac-terminal.mjs';
import { createJobExecutor } from '../scripts/job-executor.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
const config = { autoContinue: true };
const draft = (id = 'draft') => ({
  id,
  questionRootId: id,
  prompt: '原先被拒的目标',
  status: 'failed',
  stage: 'policy',
  category: '0-1 代码生成',
  excluded: true,
});
const taskOf = (turn) => ({
  id: 'project',
  title: '同一项目',
  closed: false,
  projectSeries: {
    version: seriesVersion,
    directory: 'projects/p-' + randomUUID(),
  },
  turns: [turn],
});

test('only sent business questions consume the 10+10 quota; queued roots reserve a place', () => {
  const task = taskOf(draft());
  task.turns.push(
    ...Array.from({ length: 10 }, (_, i) => ({
      ...draft('sent' + i),
      claudeAttempts: ['attempt'],
    })),
  );
  task.turns.push({
    ...draft('continuation'),
    continuationOf: 'sent0',
    claudeAttempts: ['continued'],
  });
  assert.equal(projectCounts(task)['0-1 代码生成'], 10);
  assert.equal(sentProjectCounts(task)['0-1 代码生成'], 10);
  assert.equal(canAddTurn(task, '0-1 代码生成'), false);
  assert.equal(projectQuotaComplete(task), false);
  for (let i = 0; i < 9; i++)
    task.turns.push({
      ...draft('feature' + i),
      category: 'Feature 迭代',
      promptId: 'native-' + i,
    });
  task.turns.push({
    ...draft('queued'),
    excluded: false,
    category: 'Feature 迭代',
    status: 'queued',
  });
  assert.equal(canAddTurn(task, 'Feature 迭代'), false);
  assert.equal(
    projectQuotaComplete(task),
    false,
    'reservation is not a sent question',
  );
  task.turns.at(-1).claudeAttempts = ['uncertain'];
  assert.equal(projectQuotaComplete(task), true);
  assert.equal(wasSent({ stage: 'claude' }), false);
});

test('unsent failures finish the question container without closing the project; unknown input blocks', () => {
  const turn = draft(),
    task = taskOf(turn);
  task.container = {
    questionId: turn.id,
    containerId: 'container',
    status: 'running',
  };
  assert.equal(sessionFinalization(task).reason, 'unsent-candidate-rejected');
  assert.equal(projectRecoveryDue(task, config), true);
  assert.equal(task.closed, false);
  turn.claudeAttempts = ['reserved'];
  assert.equal(sessionFinalization(task), null);
  assert.equal(projectRecoveryDue(task, config), false);
  turn.recoveryBlocked = true;
  assert.equal(projectRecoveryDue(task, config), false);
});

test('replanning respects backoff, pause, earlier running work and terminal 504 continuation', () => {
  const turn = draft(),
    task = taskOf(turn);
  turn.projectRecovery = { attempts: 3 };
  assert.equal(projectRecoveryDue(task, config), false);
  turn.projectRecovery = { attempts: 1, retryAt: '2099-01-01T00:00:00Z' };
  assert.equal(projectRecoveryDue(task, config), false);
  delete turn.projectRecovery;
  assert.equal(projectRecoveryDue(task, { autoContinue: false }), false);
  task.turns.unshift({ id: 'busy', status: 'running' });
  assert.equal(projectRecoveryDue(task, config), false);
  task.turns.shift();
  turn.gatewayRecovery = { nextTurnId: 'continue' };
  assert.equal(projectRecoveryDue(task, config), false);
});

test('completed Claude work retries only its failed postprocessing before replanning', () => {
  const turn = {
    ...draft(),
    excluded: false,
    stage: 'score',
    executionOutcome: 'complete',
    promptId: 'native',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
  };
  const task = taskOf(turn);
  assert.equal(postprocessRetryDue(task, config), true);
  assert.equal(projectRecoveryDue(task, config), false);
  turn.stageRecovery = { attempts: 1, retryAt: '2099-01-01' };
  assert.equal(postprocessRetryDue(task, config), false);
  turn.stageRecovery = { attempts: 2 };
  assert.equal(postprocessRetryDue(task, config), false);
  assert.equal(projectRecoveryDue(task, config), true);
  turn.executionOutcome = 'truncated';
  assert.equal(postprocessRetryDue(task, config), false);
  assert.equal(projectRecoveryDue(task, config), false);
});

test('global goals include later iterations, queued candidates and rejected drafts beyond old 4000-character cutoff', () => {
  const task = taskOf(draft());
  task.turns = Array.from({ length: 30 }, (_, i) => ({
    ...draft('r' + i),
    prompt: '早期目标'.repeat(100) + i,
  }));
  task.turns.push({
    ...draft('last'),
    prompt: '后期独有的目标',
    automation: {
      policy: { accepted: false, value: { reason: '相同恢复流程' } },
    },
  });
  const history = questionHistory([task]);
  assert.equal(history[0].goals.length, 31);
  assert.match(goalHistoryInstructions(history), /后期独有的目标/);
  assert.match(goalHistoryInstructions(history), /相同恢复流程/);
});

function setup(t) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'same-project-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const turn = draft(),
    task = taskOf(turn),
    dir = path.join(root, task.id);
  const workDir = path.join(dir, 'questions', turn.id, 'workspace');
  mkdirSync(path.join(workDir, task.projectSeries.directory), {
    recursive: true,
  });
  writeFileSync(
    path.join(workDir, task.projectSeries.directory, 'app.js'),
    'export const value = 1;\n',
  );
  const state = {
    taskId: task.id,
    questionId: turn.id,
    containerId: 'container',
    status: 'running',
    workDir,
    results: {},
    terminal: { terminalProtocolVersion },
  };
  let closed = 0;
  const containers = {
    load: () => state,
    owned: () => ({ State: { Running: true } }),
    native: () => [],
    close: async (id, options) => {
      assert.equal(id, task.id);
      await options.beforeExit();
      closed++;
      state.status = 'removed';
    },
  };
  return { task, turn, dir, workDir, state, containers, closed: () => closed };
}
function audit() {
  return {
    engine: 'codex-cli',
    threadId: 'codex',
    tracePath: '/fixture/policy',
    value: {
      ...fixture.questionAudit,
      allowed: true,
      checkedGroups: rules.groups.map((g) => g.id),
      matchedRuleIds: [],
      duplicateTaskIds: [],
      reason: '合规独立目标',
      simpleFeatures: [],
      difficultyEvidence: ['scope', 'context', 'interaction', 'breadth'],
      assessedDifficulty: '中等',
      followupFix: false,
      followupReason: '独立新功能',
    },
  };
}

test('safe failed draft retains code, closes only its container and prepares a different audited question', async (t) => {
  const f = setup(t);
  const original = Buffer.from('original failure bytes\n');
  writeFileSync(path.join(f.dir, f.turn.id + '.result.json'), original);
  const nextPrompt = fixture.question('新网页功能');
  const result = await planFailedProject({
    ...f,
    turn: {
      ...f.turn,
      status: 'running',
      jobToken: 'job',
      projectRetry: { originalStatus: 'failed', originalStage: 'policy' },
    },
    api: async () => ({ config, history: questionHistory([f.task]), mix: {} }),
    stage: async ({ stage, allocation }) =>
      stage === 'policy'
        ? audit()
        : {
            value: {
              action: 'advance',
              prompt: nextPrompt,
              category: allocation.categories[0],
              difficulty: '中等',
              projectEvidence: 'app.js 是网页入口',
              baseComplete: false,
            },
          },
  });
  assert.equal(
    result.result.projectRecovery.state,
    'planned',
    JSON.stringify(result.result.projectRecovery),
  );
  assert.equal(f.closed(), 1);
  assert.equal(f.task.closed, false);
  assert.equal(f.turn.prompt, '原先被拒的目标');
  assert.deepEqual(
    readFileSync(path.join(f.dir, f.turn.id + '.pre-replan-result.json')),
    original,
  );
  const recovery = result.result.projectRecovery;
  f.turn.projectRecovery = {
    ...recovery,
    state: 'continued',
    nextTurnId: 'new',
  };
  assert.equal(projectRecoveryReady(f.turn), true);
  const next = {
    id: 'new',
    questionRootId: 'new',
    projectSource: { turnId: f.turn.id, ...recovery.sourceSnapshot },
  };
  f.task.turns.push(next);
  const workDir = path.join(f.dir, 'new-workspace');
  mkdirSync(workDir);
  const runtime = Object.create(DockerRuntime.prototype);
  runtime.file = () => path.join(f.dir, 'container.json');
  runtime.save = () => {};
  runtime.importPriorQuestion({ workDir, taskId: f.task.id }, f.task, next);
  assert.equal(
    readFileSync(
      path.join(workDir, f.task.projectSeries.directory, 'app.js'),
      'utf8',
    ),
    'export const value = 1;\n',
  );
  writeFileSync(
    path.join(
      path.dirname(recovery.sourceSnapshot.manifestPath),
      'workspace',
      f.task.projectSeries.directory,
      'app.js',
    ),
    'changed',
  );
  assert.throws(() => retainRecoverySource(f), /摘要不符/);
});

test('unconfirmed native input neither closes the terminal nor calls the model to make a replacement', async (t) => {
  const f = setup(t);
  f.state.pending = { phase: 'sent' };
  const out = await planFailedProject({
    ...f,
    turn: {
      ...f.turn,
      projectRetry: { originalStatus: 'failed', originalStage: 'policy' },
    },
    api: async () => {
      throw Error('must not call');
    },
    stage: async () => {
      throw Error('must not generate');
    },
  });
  assert.equal(out.result.projectRecovery.state, 'blocked');
  assert.match(out.result.projectRecovery.reason, /未确认输入/);
  assert.equal(f.closed(), 0);
});

test('source baseline prefers the verified previous code and rejects tampered archives', (t) => {
  const f = setup(t),
    previous = {
      id: 'previous',
      status: 'review',
      permissionAudit: { passed: true },
    };
  const evidence = path.join(f.dir, 'previous.evidence');
  mkdirSync(path.join(evidence, 'workspace'), { recursive: true });
  const source = 'original verified code\n';
  writeFileSync(path.join(evidence, 'workspace', 'app.js'), source);
  const bytes = JSON.stringify({
    files: [{ name: 'workspace/app.js', sha256: hash(source), mode: 0o644 }],
    omitted: [],
  });
  writeFileSync(path.join(evidence, 'manifest.json'), bytes);
  previous.automation = {
    archive: {
      manifestPath: path.join(evidence, 'manifest.json'),
      manifestSha256: hash(bytes),
    },
  };
  f.task.turns.unshift(previous);
  const kept = retainRecoverySource(f);
  assert.equal(kept.sourceTurnId, 'previous');
  assert.equal(
    readFileSync(
      path.join(path.dirname(kept.manifestPath), 'workspace/app.js'),
      'utf8',
    ),
    source,
  );
});

test('a later permission denial disqualifies a prior archive in the same session', (t) => {
  const f = setup(t);
  f.task.turns.unshift({
    id: 'previous',
    sessionId: 'denied-session',
    status: 'review',
    permissionAudit: { passed: true },
    automation: { archive: { manifestSha256: 'untrusted', manifestPath: '/must-not-read' } },
  }, {
    id: 'denied-repair',
    sessionId: 'denied-session',
    permissionAudit: { passed: false },
  });
  const kept = retainRecoverySource(f);
  assert.equal(kept.sourceTurnId, f.turn.id);
  assert.equal(kept.baseline, 'idle-current-source');
});

test('postprocessing without its completed checkpoint preserves native identity and never invokes Claude', async (t) => {
  const f = setup(t);
  const turn = {
    ...f.turn,
    excluded: false,
    status: 'running',
    stage: 'score',
    jobToken: 'retry',
    stageRecovery: { retrying: true, attempts: 1 },
    sessionId: 'native-session',
    promptId: 'native-prompt',
    tracePath: '/original.jsonl',
    review: { scores: [4, 4, 4, 4, 4] },
  };
  const execute = createJobExecutor({
    root: process.cwd(),
    workRoot: path.dirname(f.dir),
    containers: {
      ensure() {
        throw Error('must not start Claude');
      },
    },
    api() {
      throw Error('must not reserve a call');
    },
    track() {},
    isStopping: () => false,
    release: 'test',
  });
  const { result } = await execute({
    task: { ...f.task, turns: [turn] },
    turn,
  });
  assert.match(result.error, /禁止重新发送/);
  assert.equal(result.promptId, turn.promptId);
  assert.equal(result.sessionId, turn.sessionId);
  assert.deepEqual(result.review, turn.review);
});
