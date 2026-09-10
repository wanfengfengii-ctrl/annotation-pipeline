import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  projectRegressionContext,
  assertRegressionPlanCoverage,
  regressionScoringInstructions,
  runtimeReviewContext,
  runtimeEvidenceInstructions,
  assertRegressionNextDecision,
} from '../scripts/project-regression-context.mjs';
import {
  copyVerificationSource,
  prepareRuntimeDiagnosis,
  writeRuntimeVerificationReport,
  runtimeInputDigestForImplementation,
  reuseRuntimeVerification,
} from '../scripts/runtime-verification.mjs';
import { jobReleaseProtocol } from '../scripts/job-release.mjs';

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

function reviewFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-review-lf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = path.join(root, 'browser.log');
  const numberedPath = path.join(root, 'browser.lines.jsonl');
  const text = 'progress 1\rprogress 2\r\ninstall done\r\nCanvas: true\nPASS\n';
  writeFileSync(logPath, text);
  const rows = text.split('\n').map((line, index) => ({
    line: index + 1,
    text: line,
  }));
  writeFileSync(
    numberedPath,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  const report = {
    executed: true,
    status: 'passed',
    summary: 'Browser really started',
    reportPath: path.join(root, 'report.json'),
    checks: [
      {
        ...spec('browser', 'acceptance'),
        outcome: 'passed',
        observed: 'Canvas works',
        logPath,
        logSha256: hash(readFileSync(logPath)),
        evidenceLine: 4,
      },
    ],
    diagnosisEvidence: {
      version: '2026-09-10.lf1',
      logs: [
        {
          id: 'browser',
          logPath,
          logSha256: hash(readFileSync(logPath)),
          numberedPath,
          numberedSha256: hash(readFileSync(numberedPath)),
          lineCount: rows.length,
        },
      ],
    },
  };
  const persist = () => {
    const { reportSha256: _previousHash, ...onDisk } = report;
    writeFileSync(report.reportPath, JSON.stringify(onDisk));
    report.reportSha256 = hash(readFileSync(report.reportPath));
  };
  persist();
  return { root, report, logPath, numberedPath, persist, rows };
}

test('review exposes verified LF coordinates and exact text without CR renumbering or report mutation', (t) => {
  const f = reviewFixture(t);
  const original = structuredClone(f.report);
  const originalReport = readFileSync(f.report.reportPath);
  for (const scoring of [true, false]) {
    const check = runtimeReviewContext(f.report, { scoring }).checks[0];
    assert.equal(check.evidenceCoordinatesVerified, true);
    assert.equal(check.evidenceLineBasis, 'LF');
    assert.equal(check.evidenceLine, 4);
    assert.equal(check.exactEvidenceText, 'PASS');
    assert.equal(check.lineCount, 5);
    assert.equal(check.numberedPath, f.numberedPath);
    assert.equal(check.numberedSha256, hash(readFileSync(f.numberedPath)));
  }
  assert.equal(
    readFileSync(f.logPath, 'utf8').split(/\r\n|\r|\n/)[3],
    'Canvas: true',
  );
  assert.deepEqual(f.report, original);
  assert.deepEqual(readFileSync(f.report.reportPath), originalReport);
  assert.match(runtimeEvidenceInstructions(), /read_text\(\)\.splitlines\(\)/);
  assert.match(runtimeEvidenceInstructions(), /JSONL.*line 字段/);
  assert.match(
    runtimeEvidenceInstructions(),
    /evidenceCoordinatesVerified=false/,
  );
});

test('legacy reports without numbered views explicitly expose no verified coordinates', () => {
  const report = {
    executed: true,
    status: 'passed',
    checks: [
      { ...spec('old', 'acceptance'), outcome: 'passed', evidenceLine: 7 },
    ],
  };
  const check = runtimeReviewContext(report).checks[0];
  assert.equal(check.evidenceLine, 7);
  assert.equal(check.evidenceCoordinatesVerified, false);
  for (const key of [
    'evidenceLineBasis',
    'numberedPath',
    'numberedSha256',
    'lineCount',
    'exactEvidenceText',
  ])
    assert.equal(check[key], null);
});

test('modern review rejects missing or changed report, original log and numbered view', (t) => {
  for (const kind of [
    'missing-view-metadata',
    'null-view-metadata',
    'report',
    'log',
    'view',
    'missing-log',
    'missing-view',
    'missing-report',
  ]) {
    const f = reviewFixture(t);
    if (kind === 'missing-view-metadata') delete f.report.diagnosisEvidence;
    if (kind === 'null-view-metadata') f.report.diagnosisEvidence = null;
    if (kind === 'report') writeFileSync(f.report.reportPath, '{}');
    if (kind === 'log') writeFileSync(f.logPath, 'Forged PASS\n');
    if (kind === 'view') writeFileSync(f.numberedPath, '{}\n');
    if (kind === 'missing-log') rmSync(f.logPath);
    if (kind === 'missing-view') rmSync(f.numberedPath);
    if (kind === 'missing-report') rmSync(f.report.reportPath);
    assert.throws(() => runtimeReviewContext(f.report), undefined, kind);
  }
});

test('modern review binds metadata to the report, check IDs, logs and evidence line', (t) => {
  for (const kind of [
    'check-id',
    'check-line',
    'check-log',
    'view-id',
    'view-log',
    'view-count',
    'duplicate-check',
    'duplicate-view',
    'out-of-range',
    'noninteger-line',
  ]) {
    const f = reviewFixture(t);
    const check = f.report.checks[0];
    const view = f.report.diagnosisEvidence.logs[0];
    if (kind === 'check-id') check.id = 'different';
    if (kind === 'check-line') check.evidenceLine = 3;
    if (kind === 'check-log') check.logPath = f.numberedPath;
    if (kind === 'view-id') view.id = 'different';
    if (kind === 'view-log') view.logPath = f.numberedPath;
    if (kind === 'view-count') view.lineCount++;
    if (kind === 'duplicate-check') f.report.checks.push({ ...check });
    if (kind === 'duplicate-view')
      f.report.diagnosisEvidence.logs.push({ ...view });
    if (kind === 'out-of-range') check.evidenceLine = 6;
    if (kind === 'noninteger-line') check.evidenceLine = 1.5;
    assert.throws(() => runtimeReviewContext(f.report), undefined, kind);
  }
});

test('matching file hashes alone cannot authorize altered row content, numbering or line counts', (t) => {
  for (const kind of [
    'text',
    'number',
    'count',
    'outside-directory',
    'symlink',
  ]) {
    const f = reviewFixture(t);
    const view = f.report.diagnosisEvidence.logs[0];
    if (kind === 'text') f.rows[3].text = 'Invented observed result';
    if (kind === 'number') f.rows[3].line = 5;
    if (kind === 'count') f.rows.pop();
    writeFileSync(
      f.numberedPath,
      f.rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    if (kind === 'outside-directory') {
      const outside = mkdtempSync(
        path.join(os.tmpdir(), 'runtime-review-outside-'),
      );
      t.after(() => rmSync(outside, { recursive: true, force: true }));
      view.numberedPath = path.join(outside, 'numbered.jsonl');
      writeFileSync(view.numberedPath, readFileSync(f.numberedPath));
    }
    if (kind === 'symlink') {
      const target = path.join(f.root, 'original-view.jsonl');
      writeFileSync(target, readFileSync(f.numberedPath));
      rmSync(f.numberedPath);
      symlinkSync(target, f.numberedPath);
    }
    view.numberedSha256 = hash(readFileSync(view.numberedPath));
    f.persist();
    assert.throws(() => runtimeReviewContext(f.report), undefined, kind);
  }
});

function fixture(t, { omitted = false } = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'project-regression-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'task');
  mkdirSync(dir);
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

function freezeHistoricalReport(f, turn = f.original) {
  const root = path.join(path.dirname(f.dir), 'releases', 'jobs-aaaaaaaaaaaa');
  const sources = {
    'scripts/runtime-verification.mjs': '// previous verifier\n',
    'scripts/job-executor.mjs': '// frozen entry\n',
    'scripts/docker-runtime.mjs': '// frozen runtime\n',
    'package.json': '{}\n',
  };
  for (const [file, bytes] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), bytes);
  }
  writeFileSync(
    path.join(root, 'job-release.json'),
    JSON.stringify({
      protocol: jobReleaseProtocol,
      commit: 'a'.repeat(40),
      files: Object.entries(sources).map(([file, bytes]) => ({
        path: file,
        sha256: hash(bytes),
      })),
    }),
  );
  const report = turn.automation.runtimeVerification;
  const context = {
    taskId: f.task.id,
    turnId: turn.id,
    dir: f.dir,
    workDir: f.source,
    imageId,
    prompt: turn.evaluationPrompt,
    acceptance: turn.automation.preparation.value.acceptance,
    regressionContext: report.regressionContext,
  };
  report.inputDigest = runtimeInputDigestForImplementation(
    context,
    hash(sources['scripts/runtime-verification.mjs']),
  );
  const { reportSha256: _oldHash, ...saved } = report;
  writeFileSync(report.reportPath, JSON.stringify(saved));
  report.reportSha256 = hash(readFileSync(report.reportPath));
  return { root, report, context };
}

test('verified pre-upgrade reports supply frozen historical scope without reusing their outcomes on current code', (t) => {
  const f = fixture(t, { omitted: true });
  const { report, context } = freezeHistoricalReport(f);
  const originalBytes = readFileSync(report.reportPath);
  assert.equal(reuseRuntimeVerification(report, context), null);
  writeFileSync(path.join(f.source, 'app.js'), 'console.log("new product");\n');
  assert.equal(f.inspect().checks.length, 4);
  assert.equal(
    reuseRuntimeVerification(report, { ...context, sourceIsSnapshot: true }),
    null,
  );
  assert.ok(
    reuseRuntimeVerification(report, {
      ...context,
      sourceIsSnapshot: true,
      workDir: path.join(path.dirname(report.reportPath), 'workspace'),
    }),
  );
  assert.deepEqual(readFileSync(report.reportPath), originalBytes);
  const repair = f.addReport(
    'repair',
    Object.fromEntries(ids.map((id) => [id, 'passed'])),
  );
  const fixed = freezeHistoricalReport(f, repair);
  assert.equal(
    f.inspect(),
    null,
    'verified historical fixes close only their own pending IDs',
  );
  assert.equal(
    reuseRuntimeVerification(fixed.report, fixed.context),
    null,
    'historical passes cannot skip current product verification',
  );
});

test('pre-upgrade historical verification rejects damaged releases, changed evidence and changed question inputs', (t) => {
  for (const kind of [
    'release',
    'unlisted-file',
    'missing-release',
    'prompt',
    'acceptance',
    'image',
    'log',
    'snapshot',
    'numbered-view',
  ]) {
    const f = fixture(t);
    const { root, report } = freezeHistoricalReport(f);
    if (kind === 'release')
      writeFileSync(path.join(root, 'scripts/job-executor.mjs'), 'changed');
    if (kind === 'unlisted-file')
      writeFileSync(path.join(root, 'scripts/extra.mjs'), 'unverified');
    if (kind === 'missing-release') rmSync(root, { recursive: true });
    if (kind === 'prompt')
      f.original.evaluationPrompt = 'Changed historical requirement';
    if (kind === 'acceptance')
      f.original.automation.preparation.value.acceptance = [
        'Different requirement',
      ];
    if (kind === 'image')
      f.original.container.imageId = 'sha256:' + 'b'.repeat(64);
    if (kind === 'log') writeFileSync(report.checks[1].logPath, 'forged');
    if (kind === 'snapshot')
      writeFileSync(
        path.join(path.dirname(report.reportPath), 'workspace', 'app.js'),
        'changed',
      );
    if (kind === 'numbered-view') {
      chmodSync(report.diagnosisEvidence.logs[0].numberedPath, 0o600);
      writeFileSync(report.diagnosisEvidence.logs[0].numberedPath, 'forged');
    }
    assert.throws(f.inspect, /验真失败/, kind);
  }
});

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
