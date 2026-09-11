import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  copyVerificationSource,
  runtimeEvidenceLines,
  prepareRuntimeDiagnosis,
  finalizeRuntimeReport,
  writeRuntimeVerificationReport,
  reuseRuntimeVerification,
  runtimeObservationInstructions,
} from '../scripts/runtime-verification.mjs';
import {
  assertRegressionNextDecision,
  runtimeReviewContext,
} from '../scripts/project-regression-context.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
function fixture(
  t,
  text = 'download 1%\rdownload 2%\r\n\u001b[32mASSERT PASS\u001b[0m\n',
  exitCode = 0,
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-diagnosis-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'source');
  const root = path.join(dir, 'turn.attempt-5.runtime-evidence');
  mkdirSync(workDir);
  mkdirSync(root);
  writeFileSync(path.join(workDir, 'app.js'), 'console.log(1);\n');
  const logPath = path.join(root, 'acceptance.log');
  writeFileSync(logPath, text);
  const plan = {
    value: {
      summary: 'Run actual acceptance',
      checks: [
        {
          id: 'acceptance',
          kind: 'acceptance',
          command: 'node /tmp/check.js',
          expected: 'result=1',
          requirement: 'display result',
          codeEvidence: 'app.js:1',
          timeoutSeconds: 10,
        },
      ],
    },
    tracePath: path.join(dir, 'turn.attempt-5.runtime-plan.events.jsonl'),
  };
  writeFileSync(plan.tracePath, '{}\n');
  const runs = [
    {
      id: 'acceptance',
      exitCode,
      timedOut: false,
      limited: false,
      sourceChanged: false,
      logPath,
      logSha256: sha(readFileSync(logPath)),
    },
  ];
  const executionPath = path.join(root, 'execution.json');
  writeFileSync(executionPath, JSON.stringify({ plan: plan.value, runs }));
  const sourceManifest = copyVerificationSource(workDir);
  writeFileSync(
    path.join(root, 'source-manifest.json'),
    JSON.stringify(sourceManifest),
  );
  const context = {
    dir,
    workDir,
    turnId: 'turn',
    taskId: 'task',
    imageId: 'sha256:' + 'a'.repeat(64),
    prompt: 'Show the result',
    acceptance: ['result=1'],
  };
  const preparation = {
    root,
    executionPath,
    plan,
    runs,
    prompt: context.prompt,
    acceptance: context.acceptance,
  };
  const diagnosis = {
    value: {
      summary: 'Acceptance passed',
      checks: [
        {
          id: 'acceptance',
          outcome: 'passed',
          observed: 'Result is visible',
          evidenceLine: 2,
        },
      ],
    },
    tracePath: path.join(
      dir,
      'turn.attempt-5.diagnosis-lf-1.runtime-diagnose.events.jsonl',
    ),
  };
  writeFileSync(diagnosis.tracePath, '{}\n');
  const reportInput = {
    ...context,
    sourceManifest,
    plan,
    diagnosis,
    runs,
    executionPath,
    reportPath: path.join(root, 'report.json'),
  };
  return {
    ...context,
    root,
    text,
    logPath,
    plan,
    runs,
    preparation,
    diagnosis,
    reportInput,
  };
}

test('LF view preserves CRLF, bare CR and ANSI bytes with one explicit coordinate system', (t) => {
  const f = fixture(t);
  const original = readFileSync(f.logPath);
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  const evidence = prepared.evidence.logs[0];
  const numbered = readFileSync(evidence.numberedPath, 'utf8');
  const rows = numbered.trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(rows, [
    { line: 1, text: 'download 1%\rdownload 2%\r' },
    { line: 2, text: '\u001b[32mASSERT PASS\u001b[0m' },
    { line: 3, text: '' },
  ]);
  assert.equal(evidence.lineCount, 3);
  assert.equal(evidence.logSha256, sha(original));
  assert.equal(evidence.numberedSha256, sha(numbered));
  assert.ok(!numbered.includes('\r'));
  assert.ok(!numbered.includes('\u001b'));
  assert.deepEqual(readFileSync(f.logPath), original);
  assert.match(prepared.instruction, /evidenceLine 只能使用该视图的 line 字段/);
  assert.match(
    prepared.instruction,
    /不能使用 Python read_text\(\)\.splitlines\(\)/,
  );
});

test('Unicode control characters cannot add visual evidence lines', (t) => {
  const f = fixture(t, 'before\u0085middle\u2028after\u2029end\nPASS');
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  const bytes = readFileSync(prepared.evidence.logs[0].numberedPath, 'utf8');
  assert.equal(runtimeEvidenceLines(f.text).length, 2);
  assert.ok(!/[\u0085\u2028\u2029]/.test(bytes));
  assert.deepEqual(
    bytes
      .trimEnd()
      .split('\n')
      .map(JSON.parse)
      .map((r) => r.text),
    f.text.split('\n'),
  );
});

test('a failed assertion label is retained as evidence without supplying a fabricated actual value', (t) => {
  const f = fixture(
    t,
    'ASSERT FAIL invalid procedure result is excluded from coverage\n',
    1,
  );
  const original = readFileSync(f.logPath);
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  assert.ok(prepared.instruction.includes(runtimeObservationInstructions));
  assert.match(prepared.instruction, /断言标签不是页面实际结果/);
  assert.match(
    prepared.instruction,
    /失败日志缺少判断所需的实际值.*标为 blocked/,
  );
  assert.match(prepared.instruction, /不改业务阈值或原项目测试来凑通过/);
  assert.match(prepared.instruction, /原题要求精确文本或格式时按原要求比较/);
  assert.deepEqual(readFileSync(f.logPath), original);
  assert.equal(f.runs[0].exitCode, 1);
  const rows = readFileSync(prepared.evidence.logs[0].numberedPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    rows[0].text,
    'ASSERT FAIL invalid procedure result is excluded from coverage',
  );
  assert.ok(!rows.some((row) => row.text.includes('actual=')));
});

test('LF bounds remain strict and original hash failures never become diagnosis retries', (t) => {
  const f = fixture(t);
  const universalNewlineVerdict = {
    ...f.diagnosis.value,
    checks: [{ ...f.diagnosis.value.checks[0], evidenceLine: 4 }],
  };
  assert.throws(
    () => finalizeRuntimeReport(f.plan.value, f.runs, universalNewlineVerdict),
    /日志摘要或行号无效/,
  );
  assert.equal(
    finalizeRuntimeReport(f.plan.value, f.runs, f.diagnosis.value).status,
    'passed',
  );
  writeFileSync(f.logPath, 'altered\nlog\n');
  assert.throws(
    () => prepareRuntimeDiagnosis(f.preparation),
    /原始验收日志摘要无效/,
  );
  assert.throws(
    () => finalizeRuntimeReport(f.plan.value, f.runs, f.diagnosis.value),
    /日志摘要或行号无效/,
  );
});

test('diagnosis-only recovery fills a missing report, preserves failed artifacts and rejoins standard reuse', (t) => {
  const f = fixture(t);
  const failedPath = path.join(f.dir, 'turn.attempt-5.runtime-diagnose.json');
  writeFileSync(failedPath, JSON.stringify({ evidenceLine: 4 }));
  const failedBytes = readFileSync(failedPath);
  const originalLog = readFileSync(f.logPath);
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  const input = { ...f.reportInput, diagnosisEvidence: prepared.evidence };
  const report = writeRuntimeVerificationReport(input);
  assert.equal(report.status, 'passed');
  assert.equal(reuseRuntimeVerification(report, f), report);
  assert.deepEqual(readFileSync(failedPath), failedBytes);
  assert.deepEqual(readFileSync(f.logPath), originalLog);
  assert.throws(() => writeRuntimeVerificationReport(input), /EEXIST/);
});

test('tampered numbered view is rejected when completing and reusing a report', (t) => {
  const f = fixture(t);
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  const input = { ...f.reportInput, diagnosisEvidence: prepared.evidence };
  const report = writeRuntimeVerificationReport(input);
  const view = prepared.evidence.logs[0].numberedPath;
  chmodSync(view, 0o600);
  writeFileSync(view, '{"line":2,"text":"fabricated result"}\n');
  assert.throws(
    () => writeRuntimeVerificationReport(input),
    /诊断行号证据或原始日志摘要无效/,
  );
  assert.equal(reuseRuntimeVerification(report, f), null);
});

test('recovery rejects mismatched execution records and changed project source', (t) => {
  const f = fixture(t);
  const changed = [{ ...f.runs[0], exitCode: 1 }];
  assert.throws(
    () => prepareRuntimeDiagnosis({ ...f.preparation, runs: changed }),
    /执行记录/,
  );
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  writeFileSync(path.join(f.workDir, 'app.js'), 'console.log(2);\n');
  assert.throws(
    () =>
      writeRuntimeVerificationReport({
        ...f.reportInput,
        diagnosisEvidence: prepared.evidence,
      }),
    /项目源码/,
  );
});

function withHistoricalGeometry(f, { exitCode = 1, timedOut = false } = {}) {
  const historyRoot = path.join(f.dir, 'original.runtime');
  mkdirSync(historyRoot);
  const sourceLogPath = path.join(historyRoot, 'geometry.log');
  writeFileSync(sourceLogPath, 'expected aligned panels; actual stair steps\n');
  const sourceReportPath = path.join(historyRoot, 'report.json');
  writeFileSync(
    sourceReportPath,
    JSON.stringify({
      checks: [
        { id: 'geometry', outcome: 'reproduced', logPath: sourceLogPath },
      ],
    }),
  );
  const regressionContext = {
    version: '2026-09-10.regression1',
    taskId: path.basename(f.dir),
    questionRootId: 'original',
    checks: [
      {
        id: 'geometry',
        scope: 'inherited-regression',
        requirement:
          'Paper proportions and panel positions match the selected format',
        sourcePrompt: 'Build a printable paper layout preview',
        sourceAcceptance: [
          'Paper proportions are correct; panel top edges align',
        ],
        sourceReportPath,
        sourceReportSha256: sha(readFileSync(sourceReportPath)),
        sourceLogPath,
        sourceLogSha256: sha(readFileSync(sourceLogPath)),
      },
    ],
  };
  const logPath = path.join(f.root, 'geometry.log');
  writeFileSync(
    logPath,
    exitCode === 2
      ? 'BLOCKED browser unavailable\n'
      : 'FAIL expected ratio 1.403 and aligned panels; actual 0.703 and stair steps\n',
  );
  f.plan.value.checks.push({
    id: 'geometry',
    kind: 'reproduction',
    command: 'node /tmp/geometry.js',
    expected: 'Paper proportions are correct; panel top edges align',
    requirement: regressionContext.checks[0].requirement,
    codeEvidence: 'app.js:1',
    timeoutSeconds: 10,
  });
  f.runs.push({
    id: 'geometry',
    exitCode,
    timedOut,
    limited: false,
    sourceChanged: false,
    logPath,
    logSha256: sha(readFileSync(logPath)),
  });
  writeFileSync(
    f.preparation.executionPath,
    JSON.stringify({ plan: f.plan.value, runs: f.runs }),
  );
  f.preparation.prompt = 'Fix native drag and drop only';
  f.preparation.acceptance = ['Native dragging reorders page content'];
  f.preparation.regressionContext = regressionContext;
  f.regressionContext = regressionContext;
  Object.assign(f.reportInput, {
    prompt: f.preparation.prompt,
    acceptance: f.preparation.acceptance,
    regressionContext,
  });
  return f;
}

test('historical business failure remains a project bug while passing current work is scored separately', (t) => {
  const f = withHistoricalGeometry(fixture(t));
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  assert.match(prepared.instruction, /Fix native drag and drop only/);
  assert.match(
    prepared.instruction,
    /Paper proportions are correct; panel top edges align/,
  );
  assert.match(
    prepared.instruction,
    /固定 ID 按该项 sourcePrompt\/sourceAcceptance/,
  );
  assert.match(
    prepared.instruction,
    /历史回归未被本题选中，不是 blocked 的理由/,
  );
  assert.doesNotMatch(prepared.instruction, /只有原题范围内、命令确实执行/);
  const diagnosis = {
    ...f.diagnosis,
    value: {
      summary: 'Current work passed; historical paper geometry still fails',
      checks: [
        ...f.diagnosis.value.checks,
        {
          id: 'geometry',
          outcome: 'reproduced',
          evidenceLine: 1,
          observed:
            'Current measurement still violates the original paper geometry requirement',
        },
      ],
    },
  };
  const originalLog = readFileSync(f.runs[1].logPath);
  const report = writeRuntimeVerificationReport({
    ...f.reportInput,
    diagnosis,
    diagnosisEvidence: prepared.evidence,
  });
  assert.equal(report.status, 'bugs');
  const scoring = runtimeReviewContext(report, { scoring: true });
  assert.equal(scoring.status, 'passed');
  assert.equal(scoring.projectStatus, 'bugs');
  assert.deepEqual(scoring.excludedRegressionCheckIds, ['geometry']);
  assert.deepEqual(
    scoring.checks.map((c) => c.id),
    ['acceptance'],
  );
  assert.throws(
    () => assertRegressionNextDecision(report, { action: 'complete' }),
    /仍复现缺陷/,
  );
  assert.deepEqual(readFileSync(f.runs[1].logPath), originalLog);
});

test('historical scope never authorizes turning missing execution into a reproduced bug', (t) => {
  for (const failure of [{ exitCode: 2 }, { exitCode: 1, timedOut: true }]) {
    const f = withHistoricalGeometry(fixture(t), failure);
    const prepared = prepareRuntimeDiagnosis(f.preparation);
    assert.match(
      prepared.instruction,
      /测试假设错误、证据不足或环境与执行故障仍按下方规则 blocked/,
    );
    const verdict = {
      summary: 'Historical check was blocked',
      checks: [
        ...f.diagnosis.value.checks,
        {
          id: 'geometry',
          outcome: 'blocked',
          observed: 'Execution unavailable',
          evidenceLine: 1,
        },
      ],
    };
    assert.equal(
      finalizeRuntimeReport(f.plan.value, f.runs, verdict).status,
      'blocked',
    );
    verdict.checks[1].outcome = 'reproduced';
    assert.throws(
      () => finalizeRuntimeReport(f.plan.value, f.runs, verdict),
      /真实失败的业务断言|只能标记阻塞/,
    );
  }
});

test('scope rediagnosis writes a new report beside an existing report and rejoins standard reuse without changing execution', (t) => {
  const f = withHistoricalGeometry(fixture(t));
  const previous = prepareRuntimeDiagnosis(f.preparation);
  const oldDiagnosis = {
    ...f.diagnosis,
    value: {
      summary: 'Incorrectly treated inherited scope as blocked',
      checks: [
        ...f.diagnosis.value.checks,
        {
          id: 'geometry',
          outcome: 'blocked',
          evidenceLine: 1,
          observed: 'Geometry is outside the current drag request',
        },
      ],
    },
  };
  const oldReport = writeRuntimeVerificationReport({
    ...f.reportInput,
    diagnosis: oldDiagnosis,
    diagnosisEvidence: previous.evidence,
  });
  const retained = [
    oldReport.reportPath,
    f.preparation.executionPath,
    ...f.runs.map((run) => run.logPath),
    ...previous.evidence.logs.map((log) => log.numberedPath),
  ].map((file) => [file, readFileSync(file)]);
  const prepared = prepareRuntimeDiagnosis(f.preparation);
  assert.notEqual(
    prepared.evidence.logs[0].numberedPath,
    previous.evidence.logs[0].numberedPath,
  );
  const diagnosis = {
    ...oldDiagnosis,
    tracePath: path.join(
      f.dir,
      'turn.attempt-5.scope-rediagnosis.events.jsonl',
    ),
    value: {
      summary:
        'Current work passed; inherited geometry remains a reproduced defect',
      checks: [
        ...f.diagnosis.value.checks,
        {
          id: 'geometry',
          outcome: 'reproduced',
          evidenceLine: 1,
          observed:
            'This execution reproduces incorrect geometry required by the source question',
        },
      ],
    },
  };
  writeFileSync(diagnosis.tracePath, '{}\n');
  const reportPath = path.join(f.root, 'report.diagnosis-scope-test.json');
  const input = {
    ...f.reportInput,
    reportPath,
    diagnosis,
    diagnosisEvidence: prepared.evidence,
  };
  const report = writeRuntimeVerificationReport(input);
  assert.equal(oldReport.status, 'blocked');
  assert.equal(report.status, 'bugs');
  assert.equal(
    reuseRuntimeVerification(report, {
      ...f,
      prompt: f.preparation.prompt,
      acceptance: f.preparation.acceptance,
    }),
    report,
  );
  assert.equal(
    runtimeReviewContext(report, { scoring: true }).status,
    'passed',
  );
  for (const [file, bytes] of retained)
    assert.deepEqual(readFileSync(file), bytes);
  assert.throws(() => writeRuntimeVerificationReport(input), /EEXIST/);
});

test('a diagnosis without historical context keeps the current question scope', (t) => {
  const prepared = prepareRuntimeDiagnosis(fixture(t).preparation);
  assert.match(prepared.instruction, /只有原题范围内、命令确实执行/);
  assert.doesNotMatch(prepared.instruction, /历史回归未被本题选中/);
});
