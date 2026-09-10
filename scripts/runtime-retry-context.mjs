import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  runtimeVersion,
  validateRuntimePlan,
} from '../lib/runtime-verification.mjs';
import {
  copyVerificationSource,
  runtimeHistoricalInputBinding,
  runtimeEvidenceLines,
  validateCodeRef,
  finalizeRuntimeReport,
  verifyRegressionEvidence,
} from './runtime-verification.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const same = (a, b) =>
  isDeepStrictEqual(
    JSON.parse(JSON.stringify(a)),
    JSON.parse(JSON.stringify(b)),
  );
const inventory = (manifest) => ({
  files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
  omitted: [...manifest.omitted].sort((a, b) => a.localeCompare(b)),
});

// A blocked report can guide a new attempt, but can never be reused as a pass.
// Every reference is verified against the exact logical turn and current source.
export function runtimeRetryContext(report, context) {
  if (!report) return null;
  try {
    const { taskId, turnId, dir, workDir, imageId } = context;
    const taskDir = realpathSync(dir);
    const prefix = taskDir + path.sep;
    const withinTask = (file) =>
      lstatSync(file).isFile() && realpathSync(file).startsWith(prefix);
    if (
      !taskId ||
      !turnId ||
      path.basename(taskDir) !== taskId ||
      report.version !== runtimeVersion ||
      report.status !== 'blocked' ||
      report.executed !== true ||
      report.imageId !== imageId ||
      !withinTask(report.reportPath) ||
      !path
        .basename(path.dirname(report.reportPath))
        .startsWith(turnId + '.attempt-') ||
      hash(readFileSync(report.reportPath)) !== report.reportSha256
    )
      return null;
    const inputBinding = runtimeHistoricalInputBinding(
      report,
      context,
      taskDir,
    );
    if (!inputBinding) return null;
    const { reportSha256, ...cached } = report;
    verifyRegressionEvidence(report.regressionContext, dir);
    if (
      !same(report.regressionContext || null, context.regressionContext || null)
    )
      return null;
    if (
      !same(JSON.parse(readFileSync(report.reportPath, 'utf8')), cached) ||
      !same(
        inventory(copyVerificationSource(workDir)),
        inventory(report.sourceManifest),
      )
    )
      return null;
    for (const file of [
      report.executionPath,
      report.plan.tracePath,
      report.diagnosis.tracePath,
      ...report.checks.map((c) => c.logPath),
    ])
      if (!withinTask(file)) return null;
    const execution = JSON.parse(readFileSync(report.executionPath, 'utf8'));
    if (
      !same(execution.plan, report.plan.value) ||
      !Array.isArray(execution.runs) ||
      execution.runs.length !== report.checks.length ||
      new Set(execution.runs.map((run) => run.id)).size !==
        report.checks.length ||
      execution.runs.some((run) => {
        const check = report.checks.find((c) => c.id === run.id);
        return (
          !check ||
          Object.entries(run).some(([key, value]) => !same(check[key], value))
        );
      })
    )
      return null;
    validateRuntimePlan(report.plan.value);
    for (const check of report.plan.value.checks)
      if (check.kind !== 'setup') validateCodeRef(check.codeEvidence, workDir);
    const finalized = finalizeRuntimeReport(
      report.plan.value,
      execution.runs,
      report.diagnosis.value,
    );
    if (
      finalized.status !== 'blocked' ||
      !same(finalized.checks, report.checks) ||
      finalized.summary !== report.summary
    )
      return null;
    if (report.environmentProbe) {
      const probe = report.environmentProbe;
      if (
        probe.version !== '2026-09-10.env1' ||
        probe.imageId !== imageId ||
        !withinTask(probe.logPath)
      )
        return null;
      const bytes = readFileSync(probe.logPath);
      if (
        hash(bytes) !== probe.logSha256 ||
        !same(JSON.parse(bytes.toString('utf8')), probe.capabilities)
      )
        return null;
    }
    if (report.diagnosisEvidence) {
      const evidence = report.diagnosisEvidence;
      if (
        evidence.version !== '2026-09-10.lf1' ||
        evidence.logs.length !== report.checks.length ||
        new Set(evidence.logs.map((item) => item.id)).size !==
          report.checks.length
      )
        return null;
      for (const item of evidence.logs) {
        const check = report.checks.find((c) => c.id === item.id);
        if (
          !check ||
          item.logPath !== check.logPath ||
          item.logSha256 !== check.logSha256 ||
          !withinTask(item.numberedPath)
        )
          return null;
        const original = readFileSync(item.logPath, 'utf8');
        const lines = runtimeEvidenceLines(original);
        const numbered = readFileSync(item.numberedPath, 'utf8');
        const expected =
          lines
            .map((text, index) =>
              JSON.stringify({ line: index + 1, text }).replace(
                /[\u007f-\u009f\u2028\u2029]/g,
                (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
              ),
            )
            .join('\n') + '\n';
        if (
          lines.length !== item.lineCount ||
          hash(numbered) !== item.numberedSha256 ||
          numbered !== expected
        )
          return null;
      }
    }
    return {
      version: '2026-09-10.runtime-retry1',
      taskId,
      turnId,
      imageId,
      inputDigest: report.inputDigest,
      inputBinding,
      reportPath: report.reportPath,
      reportSha256,
      status: 'blocked',
      summary: report.summary,
      checks: report.checks.map(
        ({
          id,
          kind,
          outcome,
          observed,
          logPath,
          logSha256,
          evidenceLine,
          codeEvidence,
        }) => ({
          id,
          kind,
          outcome,
          observed,
          logPath,
          logSha256,
          evidenceLine,
          codeEvidence,
        }),
      ),
    };
  } catch {
    return null;
  }
}
