import { retryCount } from './retry-policy.mjs';
import { projectRecoveryConditions } from './recovery-conditions.mjs';
import {
  projectQuotaComplete,
  unsentFailure,
  closedRepairDraft,
  frozenPreparationFailure,
} from './project-recovery.mjs';
export * from './project-recovery.mjs';

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
