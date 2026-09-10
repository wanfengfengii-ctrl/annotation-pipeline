import { questionRoot } from './question-session.mjs';

// Metadata-only gate for external delivery. The trusted runner verifies the
// local receipts and files; this module also runs in the Worker and browser.
export const submissionPolicyVersion = '2026-09-10.submission2';
const finalizationVersion = '2026-09-10.terminal-finalization1';
const sha256 = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value) => typeof value === 'string' && value.length > 0;

export function submissionIssues(task, turn) {
  // Imported records without a pipeline container retain their existing rules.
  if (!turn?.container) return [];
  const submission = turn.automation?.submission;
  if (
    submission?.version !== submissionPolicyVersion ||
    submission.status !== 'passed' ||
    submission.reviewRequiredFiles?.length
  )
    return ['本题尚未完成原 Mac 终端最终导出和提交包核验'];
  const final = submission.finalization,
    trace = final?.traceExport,
    container = turn.container,
    runId = container.terminal?.runId || container.terminalIdentity?.runId;
  let questionId;
  try {
    questionId = questionRoot(task, turn);
  } catch {
    return ['本轮原题关联不完整，不能提交'];
  }
  if (
    !nonempty(task?.id) ||
    !nonempty(questionId) ||
    !nonempty(runId) ||
    !nonempty(turn.sessionId) ||
    !sha256(container.containerId) ||
    (container.taskId && container.taskId !== task.id) ||
    (container.questionId && container.questionId !== questionId) ||
    (container.terminal?.runId &&
      container.terminalIdentity?.runId &&
      container.terminal.runId !== container.terminalIdentity.runId) ||
    final?.version !== finalizationVersion ||
    final.taskId !== task.id ||
    final.questionId !== questionId ||
    final.containerId !== container.containerId ||
    final.runId !== runId ||
    final.sessionId !== turn.sessionId
  )
    return ['最终导出回执与本轮题目、容器或原终端身份不符'];
  if (
    final.status !== 'removed' ||
    final.commandTransport !== 'original-mac-terminal' ||
    !Number.isFinite(Date.parse(final.removedAt)) ||
    trace?.verified !== true ||
    trace.exportKind !== 'final' ||
    trace.commandTransport !== 'original-mac-terminal' ||
    !Number.isSafeInteger(trace.files) ||
    trace.files < 1 ||
    !sha256(trace.sha256) ||
    submission.traceExportSha256 !== trace.sha256 ||
    !sha256(final.manifestSha256) ||
    !sha256(final.receiptSha256) ||
    !nonempty(final.receiptPath) ||
    !sha256(turn.automation?.archive?.sha256) ||
    submission.sourceArchiveSha256 !== turn.automation.archive.sha256
  )
    return ['原 Mac 终端最终导出、容器删除或提交证据绑定尚未核验'];
  return [];
}
