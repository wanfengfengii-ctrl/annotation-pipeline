import { retryBudgets } from '../lib/retry-policy.mjs';
import { projectRecoveryConditions } from '../lib/recovery-conditions.mjs';
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
  frozenPreparationFailure,
  closedRepairDraft,
} from '../lib/project-recovery.mjs';
import {
  canAddTurn,
  projectCounts,
  seriesVersion,
} from '../lib/project-series.mjs';
import { sessionFinalization } from '../lib/session-finalization.mjs';
import {
  questionHistory,
  policyHistory,
  goalHistoryInstructions,
} from '../lib/question-history.mjs';
import {
  retainRecoverySource,
  recoverySourceContext,
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

test('blocked replanning waits for changed source/session prerequisites, not a heartbeat', () => {
  const turn = draft(),
    task = taskOf(turn),
    cfg = { ...config, recoveryRevision: 'v1' };
  assert.equal(projectRecoveryDue(task, cfg), true);
  turn.projectRecovery = {
    state: 'blocked',
    blockedOnInputs: projectRecoveryConditions(task, turn, 'v1'),
  };
  assert.equal(projectRecoveryDue(task, cfg), false);
  task.revision = 999;
  turn.projectRecovery.checkedAt = new Date().toISOString();
  assert.equal(projectRecoveryDue(task, cfg), false);
  assert.equal(
    projectRecoveryDue(task, { ...cfg, recoveryRevision: 'v2' }),
    true,
  );
  task.container = {
    questionId: turn.id,
    status: 'removed',
    traceExport: { verified: true, sha256: 'new' },
  };
  assert.equal(projectRecoveryDue(task, cfg), true);
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

test('an unsent Bug preparation failure must not close the existing native question or replan another goal', () => {
  const turn = {
    ...draft(),
    category: 'Bug 修复',
    repairOf: 'prior',
    stage: 'prepare',
  };
  const task = taskOf(turn);
  task.turns.unshift({
    id: 'prior',
    status: 'review',
    promptId: 'native-input',
    sessionId: 'native-session',
    executionOutcome: 'complete',
  });
  turn.questionRootId = 'prior';
  task.container = {
    questionId: 'prior',
    containerId: 'existing-container',
    status: 'running',
  };
  assert.equal(projectRecoveryDue(task, { autoContinue: true }), false);
  assert.equal(wasSent(turn), false);
  assert.equal(sessionFinalization(task), null);
  turn.stage = 'context';
  assert.equal(sessionFinalization(task), null);
  delete turn.repairOf;
  turn.continuationOf = 'prior';
  assert.equal(sessionFinalization(task), null);
  task.closed = true;
  assert.equal(sessionFinalization(task).reason, 'operator-closed');
});

test('frozen preparation wording failures retry the same draft, while submitted inputs never qualify', () => {
  const turn = {
    ...draft(),
    stage: 'prepare',
    error: '表达修订不得改动 prepare.acceptance',
  };
  assert.equal(frozenPreparationFailure(turn), true);
  assert.equal(projectRecoveryDue(taskOf(turn), { autoContinue: true }), false);
  assert.equal(
    sessionFinalization({
      ...taskOf(turn),
      container: {
        questionId: turn.id,
        containerId: 'draft-container',
        status: 'running',
      },
    }),
    null,
  );
  for (const patch of [
    { promptId: 'native' },
    { sessionId: 'native' },
    { claudeAttempts: ['reserved'] },
    { stage: 'policy' },
    { error: 'other failure' },
  ])
    assert.equal(frozenPreparationFailure({ ...turn, ...patch }), false);
});

test('replanning respects backoff, pause, earlier running work and terminal 504 continuation', () => {
  const turn = draft(),
    task = taskOf(turn);
  turn.projectRecovery = { attempts: 3 };
  assert.equal(projectRecoveryDue(task, config), true); // Legacy totals are historical, not a lifetime cap.
  for (let i = 0; i < 3; i++)
    turn.projectRecovery.retryBudgets = retryBudgets(turn.projectRecovery, {
      stage: 'project-next',
      error: turn.error,
    });
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

test('completed Claude work keeps its artifact after bounded postprocessing retries', () => {
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
  turn.stage = 'policy';
  turn.stageRecovery = { attempts: 1, originalStage: 'score' };
  assert.equal(postprocessRetryDue(task, config), true);
  turn.stageRecovery = { attempts: 2 };
  assert.equal(postprocessRetryDue(task, config), false);
  assert.equal(projectRecoveryDue(task, config), false);
  turn.automation = { submittedPolicyEvidence: { reason: '原题重复' } };
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

test('sent-question audits keep their original history while new questions see later rejected goals', () => {
  const original = [{ id: 'older', prompt: 'earlier goal' }];
  const later = [
    ...original,
    { id: 'later', prompt: 'rejected after the original was sent' },
  ];
  assert.deepEqual(
    policyHistory(later, 'current', {
      preserveQuestion: true,
      policyOrigin: { history: original },
    }),
    original,
  );
  assert.deepEqual(
    policyHistory(later, 'current', {
      preserveQuestion: false,
      policyOrigin: { history: original },
    }),
    later,
  );
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

for (const independent of [false, true])
  test(`${independent ? 'an independent unsent draft' : 'a closed unsent Bug'} can plan from verified archived predecessor`, async (t) => {
    const f = setup(t);
    if (!independent) f.turn.repairOf = 'prior';
    f.turn.category = independent ? 'Feature 迭代' : 'Bug 修复';
    f.turn.stage = 'context';
    f.turn.questionRootId = independent ? f.turn.id : 'prior';
    const archiveRoot = path.join(f.dir, 'prior.archive');
    const fileName = 'workspace/' + f.task.projectSeries.directory + '/app.js';
    const source = 'export const value = 1;\n';
    mkdirSync(path.dirname(path.join(archiveRoot, fileName)), {
      recursive: true,
    });
    writeFileSync(path.join(archiveRoot, fileName), source);
    const manifestPath = path.join(archiveRoot, 'manifest.json');
    const manifest = JSON.stringify({
      files: [{ name: fileName, sha256: hash(source) }],
      omitted: [],
    });
    writeFileSync(manifestPath, manifest);
    const parent = {
      id: 'prior',
      questionRootId: 'prior',
      status: 'review',
      executionOutcome: 'complete',
      sessionId: 'session',
      promptId: 'native-prior',
      traceExport: { verified: true },
      permissionAudit: { passed: true },
      automation: { archive: { manifestPath, manifestSha256: hash(manifest) } },
    };
    f.task.turns.unshift(parent);
    Object.assign(f.state, {
      status: 'removed',
      questionId: 'prior',
      sessionId: 'session',
      terminal: { runId: 'original-run', terminalProtocolVersion },
      terminalFinalization: {
        runId: 'original-run',
        completedAt: '2026-09-12T00:00:00Z',
      },
      results: {
        prior: {
          success: true,
          sessionId: 'session',
          promptId: 'native-prior',
          traceExport: { verified: true },
        },
      },
    });
    const nativeRoot = path.join(f.dir, 'native');
    mkdirSync(path.join(nativeRoot, '-workspace'), { recursive: true });
    const native =
      JSON.stringify({
        type: 'user',
        uuid: 'native-prior',
        sessionId: 'session',
        message: { content: 'original business question' },
      }) +
      '\n' +
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }) +
      '\n';
    writeFileSync(path.join(nativeRoot, '-workspace/session.jsonl'), native);
    const nativeFiles = [
      {
        name: '-workspace/session.jsonl',
        bytes: Buffer.byteLength(native),
        sha256: hash(native),
      },
    ];
    const nativeManifest = path.join(f.dir, 'native-manifest.json');
    writeFileSync(nativeManifest, JSON.stringify({ files: nativeFiles }));
    f.state.traceExport = {
      verified: true,
      path: nativeRoot,
      manifestPath: nativeManifest,
      files: 1,
      sha256: hash(JSON.stringify(nativeFiles)),
    };
    f.task.container = f.state;
    assert.equal(closedRepairDraft(f.task, f.turn), !independent);
    assert.equal(projectRecoveryDue(f.task, config), true);
    for (const patch of [
      { claudeAttempts: ['uncertain'] },
      { sessionId: 'maybe-sent' },
      { questionRootId: 'other' },
      { recoveryBlocked: true },
    ])
      assert.equal(closedRepairDraft(f.task, { ...f.turn, ...patch }), false);
    assert.equal(
      closedRepairDraft(
        { ...f.task, container: { ...f.state, status: 'running' } },
        f.turn,
      ),
      false,
    );
    f.containers.owned = () => {
      throw Error('must not access removed container');
    };
    const out = await planFailedProject({
      ...f,
      turn: {
        ...f.turn,
        status: 'running',
        projectRetry: { originalStatus: 'failed', originalStage: 'context' },
      },
      api: async () => ({
        config,
        history: questionHistory([f.task]),
        mix: {},
      }),
      stage: async ({ stage, allocation }) =>
        stage === 'policy'
          ? audit()
          : {
              value: {
                action: 'advance',
                prompt: fixture.question('独立新功能'),
                category: allocation.categories[0],
                difficulty: '中等',
                projectEvidence: 'app.js',
                baseComplete: false,
              },
            },
    });
    assert.equal(
      out.result.projectRecovery.state,
      'planned',
      out.result.projectRecovery.reason,
    );
    assert.equal(
      out.result.projectRecovery.sourceSnapshot.sourceTurnId,
      'prior',
    );
    assert.equal(f.closed(), 0);
    assert.equal(f.turn.status, 'failed');
    assert.equal(f.turn.category, independent ? 'Feature 迭代' : 'Bug 修复');
    assert.equal(
      readFileSync(path.join(nativeRoot, '-workspace/session.jsonl'), 'utf8'),
      native,
    );
    // A terminal receipt alone must not let untracked native input pass.
    const mismatched = structuredClone(f.task);
    mismatched.turns[0].promptId = 'different-known-input';
    const rejected = await planFailedProject({
      ...f,
      task: mismatched,
      turn: {
        ...f.turn,
        projectRetry: { originalStatus: 'failed', originalStage: 'context' },
      },
      api: async () => {
        throw Error('must not generate');
      },
      stage: async () => {
        throw Error('must not generate');
      },
    });
    assert.equal(rejected.result.projectRecovery.state, 'blocked');
    assert.match(rejected.result.projectRecovery.reason, /原生输入/);
  });

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

test('same-project replan supplies bounded verified source to both read-only stages without exposing credentials', async (t) => {
  const f = setup(t);
  const source = retainRecoverySource(f);
  const sourceFile = path.join(
    path.dirname(source.manifestPath),
    'workspace',
    f.task.projectSeries.directory,
    'app.js',
  );
  const context = JSON.parse(recoverySourceContext(source));
  assert.equal(context.charactersIncluded, 'export const value = 1;\n'.length);
  assert.match(
    context.files.find((file) => file.path.endsWith('/app.js')).content,
    /export const value/,
  );
  writeFileSync(
    sourceFile,
    'const API_KEY = "secret-value-should-not-leak";\n',
  );
  assert.throws(() => recoverySourceContext(source), /摘要不符/);

  // Use a fresh verified snapshot for the actual planner flow; its stage mock
  // proves the context reaches project-next and the independent policy audit.
  const g = setup(t),
    prompts = {};
  writeFileSync(
    path.join(g.workDir, g.task.projectSeries.directory, 'private.js'),
    'const API_KEY = "secret-value-should-not-leak";\n',
  );
  const result = await planFailedProject({
    ...g,
    turn: {
      ...g.turn,
      status: 'running',
      jobToken: 'job',
      projectRetry: { originalStatus: 'failed', originalStage: 'policy' },
    },
    api: async () => ({ config, history: questionHistory([g.task]), mix: {} }),
    stage: async ({ stage, allocation, prompt }) => {
      prompts[stage] = prompt;
      return stage === 'policy'
        ? audit()
        : {
            value: {
              action: 'advance',
              prompt: fixture.question('有依据的独立功能'),
              category: allocation.categories[0],
              difficulty: '中等',
              projectEvidence: 'app.js 是当前网页入口',
              baseComplete: false,
            },
          };
    },
  });
  assert.equal(result.result.projectRecovery.state, 'planned');
  assert.match(prompts['project-next'], /recovery-source-context2/);
  assert.match(prompts['project-next'], /export const value = 1/);
  assert.doesNotMatch(prompts['project-next'], /secret-value-should-not-leak/);
  assert.match(prompts.policy, /recovery-source-context2/);
  assert.match(prompts.policy, /export const value = 1/);
  assert.doesNotMatch(prompts.policy, /secret-value-should-not-leak/);
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
  f.task.turns.unshift(
    {
      id: 'previous',
      sessionId: 'denied-session',
      status: 'review',
      permissionAudit: { passed: true },
      automation: {
        archive: {
          manifestSha256: 'untrusted',
          manifestPath: '/must-not-read',
        },
      },
    },
    {
      id: 'denied-repair',
      sessionId: 'denied-session',
      permissionAudit: { passed: false },
    },
  );
  const kept = retainRecoverySource(f);
  assert.equal(kept.sourceTurnId, f.turn.id);
  assert.equal(kept.baseline, 'idle-current-source');
});

test('an API failure before postprocessing reaches Claude collection preserves cached native evidence', async (t) => {
  const f = setup(t);
  const native = {
    success: true,
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/original.jsonl',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
    executionOutcome: 'complete',
    output: 'original output',
  };
  writeFileSync(
    path.join(f.dir, f.turn.id + '.stages.json'),
    JSON.stringify({
      claude: native,
      prepare: {
        value: {
          prompt: f.turn.prompt,
          category: f.turn.category,
          difficulty: '中等',
          acceptance: ['original'],
        },
      },
    }),
  );
  const turn = {
    ...f.turn,
    status: 'running',
    stageRecovery: { attempts: 1, retrying: true },
    review: { scores: [4, 4, 4, 4, 4] },
  };
  const execute = createJobExecutor({
    root: process.cwd(),
    workRoot: path.dirname(f.dir),
    containers: {
      ...f.containers,
      public: (s) => s,
      execute() {
        throw Error('must not execute Claude');
      },
    },
    api() {
      throw Error('API unavailable before stage');
    },
    track() {},
    isStopping: () => false,
    release: 'test',
  });
  const { result } = await execute({
    task: { ...f.task, turns: [turn] },
    turn,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /API unavailable/);
  for (const key of [
    'sessionId',
    'promptId',
    'tracePath',
    'traceExport',
    'permissionAudit',
    'output',
  ])
    assert.deepEqual(result[key], native[key], key);
  assert.deepEqual(result.review, turn.review);
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
