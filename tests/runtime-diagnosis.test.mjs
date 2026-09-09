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
} from '../scripts/runtime-verification.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
function fixture(
  t,
  text = 'download 1%\rdownload 2%\r\n\u001b[32mASSERT PASS\u001b[0m\n',
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
      exitCode: 0,
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
