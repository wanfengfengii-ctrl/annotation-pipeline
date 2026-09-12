import { retryCount } from './retry-policy.mjs';
import { runtimeRecoveryEligible } from './runtime-recovery.mjs';
import workflow from '../rules/workflow.json' with { type: 'json' };

export const projectRecoveryVersion = '2026-09-11.same-project1';
export const replacementCategories = ['0-1 代码生成', 'Feature 迭代'];
export function wasSent(turn) {
  // An uncertain reserved call consumes quota too. Never infer a send from a
  // stage name: preparation and failed context checks can reach those names.
  return !!(turn.promptId || turn.sessionId || turn.claudeAttempts?.length);
}
export function sentProjectCounts(task) {
  return Object.fromEntries(
    replacementCategories.map((category) => [
      category,
      task.turns.filter(
        (r) =>
          !r.repairOf &&
          !r.continuationOf &&
          r.category === category &&
          wasSent(r),
      ).length,
    ]),
  );
}
export function projectQuotaComplete(task) {
  const counts = sentProjectCounts(task);
  return replacementCategories.every(
    (c) => counts[c] >= workflow.projectLimits[c],
  );
}
export function projectRecoveryReady(turn) {
  const r = turn?.projectRecovery;
  return !!(
    r?.version === projectRecoveryVersion &&
    r.turnId === turn.id &&
    r.state === 'continued' &&
    r.nextTurnId &&
    r.idleVerified === true &&
    r.sourceSnapshot?.verified &&
    /^[a-f0-9]{64}$/.test(r.sourceSnapshot.manifestSha256 || '')
  );
}
// Replanning a completed but blocked project is distinct from replaying its
// business question. The planner still verifies source, idle state and quota.
export function blockedProjectRetryAllowed(task, turn) {
  return !!(
    task?.projectSeries &&
    !task.closed &&
    turn &&
    task.turns.at(-1)?.id === turn.id &&
    !projectQuotaComplete(task) &&
    !turn.excluded &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    !task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    ) &&
    turn.projectRecovery?.state === 'blocked' &&
    !turn.projectRecovery.nextTurnId &&
    (turn.status === 'failed' ||
      (turn.status === 'review' &&
        turn.executionOutcome === 'complete' &&
        turn.traceExport?.verified &&
        turn.permissionAudit?.passed &&
        turn.automation?.archive))
  );
}
export function stoppedCompletionRetryAllowed(task, turn) {
  return !!(
    task &&
    turn &&
    !task.closed &&
    task.turns.at(-1)?.id === turn.id &&
    !task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    ) &&
    !turn.excluded &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    turn.status === 'failed' &&
    turn.stage === 'context' &&
    wasSent(turn) &&
    !turn.projectRecovery &&
    task.container?.containerId &&
    task.container.questionId === (turn.questionRootId || turn.id) &&
    ['running', 'stopped'].includes(task.container.status) &&
    /此题容器已停止，只能导出归档，不能重启旧任务/.test(turn.error || '')
  );
}
export function queuedProjectRecovery(task) {
  const turn = task.turns.at(-1);
  if (turn?.status !== 'queued' || !turn.projectRetry) return false;
  const restored = { ...turn, status: turn.projectRetry.originalStatus };
  return blockedProjectRetryAllowed(
    { ...task, turns: [...task.turns.slice(0, -1), restored] },
    restored,
  );
}
export function unsentFailure(turn) {
  return (
    turn?.status === 'failed' &&
    !wasSent(turn) &&
    !turn.recoveryBlocked &&
    ['context', 'scaffold', 'prepare', 'policy', 'snapshot'].includes(
      turn.stage,
    )
  );
}
// An independent draft may fail before it ever creates its own container.
// Its completed predecessor remains the source; it is never this draft's session.
export function archivedPredecessor(task, turn, container) {
  if (
    !unsentFailure(turn) ||
    turn.repairOf ||
    turn.continuationOf ||
    container?.taskId !== task.id ||
    container.status !== 'removed' ||
    !container.traceExport?.verified ||
    !container.terminal?.runId
  )
    return null;
  const index = task.turns.findIndex((r) => r.id === turn.id);
  if (index < 1) return null;
  const previous = task.turns
    .slice(0, index)
    .filter((r) => (r.questionRootId || r.id) === container.questionId);
  const last = previous.at(-1);
  if (
    !last ||
    !['review', 'submitted'].includes(last.status) ||
    last.excluded ||
    last.executionOutcome !== 'complete' ||
    last.sessionId !== container.sessionId ||
    !last.promptId ||
    !last.permissionAudit?.passed ||
    !last.traceExport?.verified ||
    !/^[a-f0-9]{64}$/.test(last.automation?.archive?.manifestSha256 || '') ||
    previous.some(
      (r) => r.recoveryBlocked || r.permissionAudit?.passed === false,
    )
  )
    return null;
  return last;
}
export function frozenPreparationFailure(turn) {
  return (
    unsentFailure(turn) &&
    turn.stage === 'prepare' &&
    (turn.error || '').startsWith('表达修订不得改动 prepare.')
  );
}
// A previously closed conversation cannot accept its unsent Bug draft. It may
// only supply verified source for a distinct independent goal in this project.
export function closedRepairDraft(task, turn) {
  const index = task.turns?.findIndex((r) => r.id === turn?.id) ?? -1;
  const parent = task.turns
    ?.slice(0, Math.max(0, index))
    .find((r) => r.id === turn?.repairOf);
  const container = task.container;
  return !!(
    unsentFailure(turn) &&
    turn.repairOf &&
    parent &&
    container?.status === 'removed' &&
    container.traceExport?.verified === true &&
    typeof container.terminal?.runId === 'string' &&
    container.terminal.runId.length > 0 &&
    container.terminalFinalization?.runId === container.terminal?.runId &&
    container.terminalFinalization?.completedAt &&
    turn.questionRootId === container.questionId &&
    (parent.questionRootId || parent.id) === container.questionId &&
    parent.promptId &&
    parent.sessionId &&
    parent.sessionId === container.sessionId &&
    parent.executionOutcome === 'complete' &&
    parent.permissionAudit?.passed === true &&
    parent.traceExport?.verified === true &&
    /^[a-f0-9]{64}$/.test(parent.automation?.archive?.manifestSha256 || '')
  );
}
export function validationRetryAllowed(task, turn) {
  return !!(
    turn &&
    task.turns.at(-1)?.id === turn.id &&
    !task.closed &&
    !turn.excluded &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    !turn.recoveryBlocked &&
    !turn.automation?.submittedPolicyEvidence &&
    !turn.projectRecovery?.nextTurnId &&
    (turn.status === 'failed' ||
      (turn.status === 'queued' &&
        (turn.projectRetry || runtimeRecoveryEligible(turn)))) &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    turn.promptId &&
    turn.sessionId &&
    task.turns.every(
      (r) =>
        r.id === turn.id ||
        (!r.recoveryBlocked && !['running', 'queued'].includes(r.status)),
    )
  );
}

export function historicalValidationRetryAllowed(task, turn) {
  return !!(
    turn &&
    task.turns.some((r) => r.id === turn.id) &&
    task.turns.at(-1)?.id !== turn.id &&
    turn.status === 'failed' &&
    !turn.excluded &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    !turn.recoveryBlocked &&
    !turn.automation?.submittedPolicyEvidence &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    turn.promptId &&
    turn.sessionId &&
    turn.questionRootId &&
    turn.container?.questionId === turn.questionRootId
  );
}

export function postprocessRetryDue(task, config, now = Date.now()) {
  const r = task.turns.at(-1);
  return !!(
    task.projectSeries &&
    !task.closed &&
    config.autoContinue &&
    r &&
    r.status === 'failed' &&
    !r.excluded &&
    !r.recoveryBlocked &&
    r.executionOutcome === 'complete' &&
    r.traceExport?.verified &&
    r.permissionAudit?.passed &&
    [
      'runtime-plan',
      'runtime-running',
      'runtime-diagnose',
      'score',
      'delivery',
    ].includes(r.stageRecovery?.originalStage || r.stage) &&
    retryCount(r.stageRecovery, {
      stage: r.stage,
      error: r.error,
      revision: config.recoveryRevision,
    }) < 2 &&
    now >= Date.parse(r.stageRecovery?.retryAt || '1970-01-01') &&
    !task.turns.some(
      (x) => x.recoveryBlocked || ['queued', 'running'].includes(x.status),
    )
  );
}
