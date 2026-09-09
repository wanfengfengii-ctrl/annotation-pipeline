import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  projectRegressionContext,
  assertRegressionPlanCoverage,
  regressionScoringInstructions,
  runtimeReviewContext,
  assertRegressionNextDecision,
} from '../scripts/project-regression-context.mjs';
import {
  copyVerificationSource,
  prepareRuntimeDiagnosis,
  writeRuntimeVerificationReport,
} from '../scripts/runtime-verification.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ids = ['timeline', 'scene_ports', 'sequential_moves', 'clock'];
const imageId = 'sha256:' + 'a'.repeat(64);
const spec = (id, kind = 'reproduction') => ({
  id,
  kind,
  command: 'node /tmp/check.js',
  expected: id + ' behaves as requested',
  requirement: 'Original requirement: ' + id,
  codeEvidence: kind === 'setup' ? '无' : 'app.js:1',
  timeoutSeconds: 10,
});

test('scoring separates successful current work from still reproduced inherited project bugs', () => {
  const report = {
    executed: true,
    status: 'bugs',
    summary: 'Old scene-port behavior still fails',
    reportPath: '/task/current/report.json',
    reportSha256: 'b'.repeat(64),
    regressionContext: {
      checks: [
        { id: 'timeline', scope: 'question' },
        { id: 'scene_ports', scope: 'inherited-regression' },
      ],
    },
    checks: [
      { ...spec('setup', 'setup'), outcome: 'passed' },
      { ...spec('main', 'acceptance'), outcome: 'passed' },
      { ...spec('timeline'), outcome: 'not_reproduced' },
      { ...spec('scene_ports'), outcome: 'reproduced' },
    ],
  };
  const original = structuredClone(report);
  const next = runtimeReviewContext(report);
  assert.equal(next.status, 'bugs');
  assert.equal(next.summary, report.summary);
  assert.equal(next.checks.length, 4);
  assert.deepEqual(
    next.checks.map((check) => check.scope),
    ['question', 'question', 'question', 'inherited-regression'],
  );
  const score = runtimeReviewContext(report, { scoring: true });
  assert.equal(score.status, 'passed');
  assert.equal(score.projectStatus, 'bugs');
  assert.equal(score.reportPath, report.reportPath);
  assert.deepEqual(score.excludedRegressionCheckIds, ['scene_ports']);
  assert.deepEqual(
    score.checks.map((check) => check.id),
    ['setup', 'main', 'timeline'],
  );
  assert.match(score.summary, /通过 2 项，复现 0 项/);
  assert.doesNotMatch(score.summary, /scene-port/);
  assert.deepEqual(report, original);
  report.checks.find((check) => check.id === 'timeline').outcome = 'reproduced';
  assert.equal(runtimeReviewContext(report, { scoring: true }).status, 'bugs');
  report.checks.find((check) => check.id === 'timeline').outcome = 'blocked';
  assert.equal(
    runtimeReviewContext(report, { scoring: true }).status,
    'blocked',
  );
});

test('scoped review does not treat missing business evidence as a pass or inherit global blocked into a passed question', () => {
  const report = {
    executed: true,
    status: 'blocked',
    summary: 'Historical regression blocked',
    regressionContext: { checks: [{ id: 'old_bug' }] },
    checks: [
      { ...spec('main', 'acceptance'), outcome: 'passed' },
      { ...spec('old_bug'), outcome: 'blocked' },
    ],
  };
  assert.equal(
    runtimeReviewContext(report, { scoring: true }).status,
    'passed',
  );
  assert.equal(
    runtimeReviewContext(report, { scoring: true }).projectStatus,
    'blocked',
  );
  report.checks.shift();
  assert.equal(
    runtimeReviewContext(report, { scoring: true }).status,
    'blocked',
  );
  assert.deepEqual(runtimeReviewContext(report, { scoring: true }).checks, []);
  assert.equal(runtimeReviewContext(null), null);
});

function fixture(t, { omitted = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'project-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'current-product');
  mkdirSync(source);
  writeFileSync(path.join(source, 'app.js'), 'console.log("original");\n');
  if (omitted) {
    mkdirSync(path.join(source, 'node_modules'));
    writeFileSync(path.join(source, 'node_modules', 'ignored.js'), 'ignored');
  }
  const task = { id: path.basename(dir), turns: [] };
  function addReport(turnId, outcomes, options = {}) {
    const root = path.join(dir, turnId + '.attempt-1.runtime-history');
    mkdirSync(root);
    const sourceManifest = copyVerificationSource(
      source,
      path.join(root, 'workspace'),
    );
    writeFileSync(
      path.join(root, 'source-manifest.json'),
      JSON.stringify(sourceManifest),
    );
    const checks = [
      spec('acceptance', 'acceptance'),
      ...Object.keys(outcomes).map((id) => spec(id)),
    ];
    const plan = {
      value: { summary: 'Execute existing requirements', checks },
      tracePath: path.join(root, 'plan.jsonl'),
    };
    writeFileSync(plan.tracePath, '{}\n');
    const runs = checks.map((check) => {
      const outcome = outcomes[check.id] || 'passed';
      const logPath = path.join(root, check.id + '.log');
      writeFileSync(logPath, 'Observed current behavior: ' + outcome + '\n');
      return {
        id: check.id,
        exitCode: outcome === 'reproduced' ? 1 : outcome === 'blocked' ? 2 : 0,
        logPath,
        logSha256: hash(readFileSync(logPath)),
        timedOut: false,
        limited: false,
        sourceChanged: false,
      };
    });
    const executionPath = path.join(root, 'execution.json');
    writeFileSync(executionPath, JSON.stringify({ plan: plan.value, runs }));
    const prompt = options.prompt || 'Original four-part project requirement';
    const acceptance = ['Existing project behavior works'];
    const context = { dir, workDir: source, imageId, prompt, acceptance };
    const diagnosis = {
      value: {
        summary: 'Observed existing behavior',
        checks: checks.map((check) => ({
          id: check.id,
          outcome: outcomes[check.id] || 'passed',
          observed: 'Observed current ' + check.id,
          evidenceLine: 1,
        })),
      },
      tracePath: path.join(root, 'diagnosis.jsonl'),
    };
    writeFileSync(diagnosis.tracePath, '{}\n');
    const prepared = prepareRuntimeDiagnosis({
      root,
      executionPath,
      plan,
      runs,
      ...context,
    });
    const report = writeRuntimeVerificationReport({
      ...context,
      sourceManifest,
      plan,
      diagnosis,
      runs,
      reportPath: path.join(root, 'report.json'),
      executionPath,
      diagnosisEvidence: prepared.evidence,
    });
    const turn = {
      id: turnId,
      questionRootId: options.rootId || 'original',
      status: 'review',
      prompt,
      evaluationPrompt: prompt,
      container: { imageId },
      automation: {
        preparation: { value: { prompt, acceptance } },
        runtimeVerification: report,
      },
    };
    task.turns.push(turn);
    return turn;
  }
  const original = addReport(
    'original',
    Object.fromEntries(ids.map((id) => [id, 'reproduced'])),
  );
  const current = {
    id: 'current',
    questionRootId: 'original',
    repairOf: 'original',
    repairCheckIds: ['timeline', 'clock'],
    prompt: 'Only fix timeline and clock',
  };
  const inspect = () =>
    projectRegressionContext(
      { ...task, turns: [...task.turns, current] },
      current,
      { dir, imageId },
    );
  return { task, current, original, addReport, inspect, dir, source };
}

test('historical defects survive a narrowed question and changed current source with bound evidence', (t) => {
  const f = fixture(t);
  const originalReport = f.original.automation.runtimeVerification;
  const originalBytes = readFileSync(originalReport.reportPath);
  writeFileSync(path.join(f.source, 'app.js'), 'console.log("new product");\n');
  const context = f.inspect();
  assert.deepEqual(
    context.checks.map((check) => check.id).sort((a, b) => a.localeCompare(b)),
    [...ids].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(context.questionRootId, 'original');
  for (const check of context.checks) {
    assert.equal(check.scope, 'inherited-regression');
    assert.equal(check.sourceTurnId, 'original');
    assert.equal(
      check.sourceReportSha256,
      hash(readFileSync(check.sourceReportPath)),
    );
    assert.equal(
      check.sourceLogSha256,
      hash(readFileSync(check.sourceLogPath)),
    );
    assert.equal(check.sourcePrompt, f.original.evaluationPrompt);
  }
  assert.deepEqual(readFileSync(originalReport.reportPath), originalBytes);
  assert.equal(f.current.prompt, 'Only fix timeline and clock');
});

test('only a newer verified passed or not_reproduced check removes its own pending ID', (t) => {
  const f = fixture(t);
  f.addReport('repair_one', { timeline: 'passed', clock: 'not_reproduced' });
  assert.deepEqual(
    f.inspect().checks.map((check) => check.id),
    ['scene_ports', 'sequential_moves'],
  );
  const latest = f.addReport('regression_again', { scene_ports: 'reproduced' });
  assert.equal(
    f.inspect().checks.find((check) => check.id === 'scene_ports')
      .sourceReportSha256,
    latest.automation.runtimeVerification.reportSha256,
  );
  f.addReport('repair_two', {
    scene_ports: 'passed',
    sequential_moves: 'not_reproduced',
  });
  assert.equal(f.inspect(), null);
});

test('fresh question roots do not inherit another session and current reports are not history', (t) => {
  const f = fixture(t);
  assert.equal(
    projectRegressionContext(f.task, f.original, { dir: f.dir, imageId }),
    null,
  );
  const fresh = { id: 'fresh', questionRootId: 'fresh' };
  assert.equal(
    projectRegressionContext(
      { ...f.task, turns: [...f.task.turns, fresh] },
      fresh,
      { dir: f.dir, imageId },
    ),
    null,
  );
});

test('historical input, report, log and frozen source tampering fail closed', (t) => {
  for (const kind of ['input', 'report', 'log', 'workspace', 'image']) {
    const f = fixture(t);
    const report = f.original.automation.runtimeVerification;
    if (kind === 'input')
      f.original.evaluationPrompt = 'Changed historical question';
    if (kind === 'report') writeFileSync(report.reportPath, '{}');
    if (kind === 'log')
      writeFileSync(report.checks[1].logPath, 'Forged outcome\n');
    if (kind === 'workspace')
      writeFileSync(
        path.join(path.dirname(report.reportPath), 'workspace', 'app.js'),
        'altered',
      );
    if (kind === 'image')
      f.original.container.imageId = 'sha256:' + 'b'.repeat(64);
    assert.throws(f.inspect, /验真失败/, kind);
  }
});

test('frozen snapshots retain the original omitted inventory without requiring omitted source files', (t) => {
  const f = fixture(t, { omitted: true });
  assert.deepEqual(
    f.original.automation.runtimeVerification.sourceManifest.omitted,
    ['node_modules'],
  );
  assert.equal(f.inspect().checks.length, 4);
});

test('missing or blocked later evidence cannot silently erase previously reproduced defects', (t) => {
  const f = fixture(t);
  f.addReport('blocked_retest', { scene_ports: 'blocked' });
  assert.throws(f.inspect, /验真失败/);
  delete f.task.turns.at(-1).automation.runtimeVerification;
  assert.throws(f.inspect, /缺少前轮验收报告/);
});

test('coverage requires every fixed ID as a real non-setup step and preserves scoring scope', (t) => {
  const f = fixture(t);
  const context = f.inspect();
  const plan = {
    summary: 'Full regression',
    checks: [spec('acceptance', 'acceptance'), ...ids.map((id) => spec(id))],
  };
  assert.equal(assertRegressionPlanCoverage(plan, context), plan);
  for (const change of ['missing', 'rename', 'setup', 'duplicate']) {
    const invalid = structuredClone(plan);
    if (change === 'missing') invalid.checks.pop();
    if (change === 'rename') invalid.checks.at(-1).id = 'renamed';
    if (change === 'setup') invalid.checks.at(-1).kind = 'setup';
    if (change === 'duplicate')
      invalid.checks.push(structuredClone(invalid.checks.at(-1)));
    assert.throws(() => assertRegressionPlanCoverage(invalid, context));
  }
  const onlyHistoricalAcceptance = structuredClone(plan);
  onlyHistoricalAcceptance.checks.shift();
  onlyHistoricalAcceptance.checks[0].kind = 'acceptance';
  assert.throws(
    () => assertRegressionPlanCoverage(onlyHistoricalAcceptance, context),
    /不能用历史回归代替/,
  );
  const instructions = regressionScoringInstructions(context);
  assert.match(instructions, /未要求修复的历史问题不得扣本轮交付完整性/);
  assert.match(instructions, /不能当作本轮的新执行结果/);
  assert.equal(regressionScoringInstructions(null), '');
});

test('next decisions cannot complete a partial repair while fresh inherited bugs remain', () => {
  const report = {
    status: 'bugs',
    regressionContext: {
      version: '2026-09-10.regression1',
      checks: [{ id: 'old_bug', scope: 'inherited-regression' }],
    },
    plan: {
      value: {
        summary: 'Current question plus historical regression',
        checks: [spec('current_acceptance', 'acceptance'), spec('old_bug')],
      },
    },
    checks: [
      { ...spec('current_acceptance', 'acceptance'), outcome: 'passed' },
      { ...spec('old_bug'), outcome: 'reproduced' },
    ],
  };
  for (const decision of [
    { action: 'complete' },
    { action: 'advance' },
    { action: 'repair', baseComplete: true },
  ])
    assert.throws(
      () => assertRegressionNextDecision(report, decision),
      /仍复现缺陷/,
    );
  for (const action of ['repair', 'needs_input']) {
    const decision = { action };
    assert.equal(assertRegressionNextDecision(report, decision), decision);
  }
  report.checks[1].outcome = 'passed';
  report.status = 'passed';
  assert.equal(
    assertRegressionNextDecision(report, { action: 'advance' }).action,
    'advance',
  );
  report.checks[1].outcome = 'blocked';
  assert.throws(
    () => assertRegressionNextDecision(report, { action: 'needs_input' }),
    /未完成真实复验/,
  );
  report.checks.pop();
  assert.throws(
    () => assertRegressionNextDecision(report, { action: 'complete' }),
    /未完成真实复验/,
  );
  report.plan.value.checks.pop();
  assert.throws(
    () => assertRegressionNextDecision(report, { action: 'needs_input' }),
    /遗漏历史待复核/,
  );
  assert.throws(
    () =>
      assertRegressionNextDecision(
        { status: 'blocked', checks: [] },
        { action: 'needs_input' },
      ),
    /验收阻塞/,
  );
});
