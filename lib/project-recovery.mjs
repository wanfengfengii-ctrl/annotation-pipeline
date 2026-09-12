import { retryCount } from './retry-policy.mjs';
import { runtimeRecoveryEligible } from './runtime-recovery.mjs';
import { projectRecoveryConditions } from './recovery-conditions.mjs';
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
export function projectRecoveryDue(task, config, now = Date.now()) {
  const turn = task.turns.at(-1);
  if (
    !task.projectSeries ||
    task.closed ||
    !config.autoContinue ||
    projectQuotaComplete(task) ||
    !turn ||
    task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    ) ||
    turn.gatewayRecovery?.nextTurnId ||
    turn.projectRecovery?.nextTurnId
  )
    return false;
  const record = turn.projectRecovery;
  if (
    record?.blockedOnInputs ===
    projectRecoveryConditions(task, turn, config.recoveryRevision)
  )
    return false;
  if (
    retryCount(record, {
      stage: 'project-next',
      error: record?.reason || turn.error,
      revision: config.recoveryRevision,
    }) >= 3 ||
    now < Date.parse(record?.retryAt || '1970-01-01')
  )
    return false;
  // An unsent Bug draft belongs to an existing native conversation. Its
  // earlier messages are expected, not evidence that this draft was sent.
  // Retry preparation in that conversation instead of replacing the question.
  if (unsentFailure(turn))
    return (
      closedRepairDraft(task, turn) ||
      (!turn.repairOf && !frozenPreparationFailure(turn))
    );
  if (
    turn.status === 'failed' &&
    turn.executionOutcome === 'error' &&
    turn.traceExport?.verified &&
    turn.promptId &&
    turn.sessionId
  )
    return true;
  if (
    turn.status === 'failed' &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    (turn.stageRecovery?.attempts || 0) >= 2
  )
    return !!turn.automation?.submittedPolicyEvidence;
  // A finished question/session is not a finished project. Runtime blocks and
  // unresolved Bugs still need evidence; they are never relabelled as new work.
  return (
    ['review', 'submitted'].includes(turn.status) &&
    !turn.excluded &&
    turn.automation?.archive &&
    turn.automation?.runtimeVerification?.status === 'passed' &&
    (['complete', 'needs_input'].includes(
      turn.automation?.next?.value?.action,
    ) ||
      !!turn.automation?.nextError)
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
