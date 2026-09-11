import {
  gatewayFailureValid,
  gatewayContinuationVersion,
} from './gateway-continuation.mjs';
import { projectRecoveryReady } from './project-recovery.mjs';
export const disputedContinuationVersion = '2026-09-10.disputed-continuation1';

// Completing an evaluation does not approve its question or make it exportable.
export function disputedEvaluationComplete(turn) {
  const a = turn?.automation,
    evidence = a?.submittedPolicyEvidence;
  return !!(
    evidence?.receipt &&
    evidence.postExecutionPolicy?.some((p) => p.disputed === true) &&
    turn.executionOutcome === 'complete' &&
    !turn.recoveryBlocked &&
    evidence.receipt.sessionId === turn.sessionId &&
    evidence.receipt.promptId === turn.promptId &&
    turn.traceExport?.verified === true &&
    evidence.receipt.nativeExportSha256 === turn.traceExport.sha256 &&
    turn.permissionAudit?.passed === true &&
    turn.review?.source === 'codex' &&
    turn.review.scores?.length === 5 &&
    a.delivery?.value?.passed === true &&
    a.runtimeVerification?.executed === true &&
    ['passed', 'bugs'].includes(a.runtimeVerification.status) &&
    a.runtimeVerification.reportSha256 &&
    !a.archive &&
    !a.bundlePath
  );
}

export function disputeContinuationReady(turn) {
  const c = turn?.automation?.projectContinuation;
  return !!(
    disputedEvaluationComplete(turn) &&
    c?.version === disputedContinuationVersion &&
    c.turnId === turn.id &&
    c.sessionId === turn.sessionId &&
    c.promptId === turn.promptId &&
    c.runtimeReportSha256 ===
      turn.automation.runtimeVerification.reportSha256 &&
    c.sourceSnapshot?.verified === true &&
    c.sourceSnapshot.manifestSha256 &&
    ['ready', 'planned', 'continued'].includes(c.state)
  );
}

export function blocksProject(turn) {
  return (
    turn.status === 'failed' &&
    !turn.excluded &&
    !projectRecoveryReady(turn) &&
    !(
      gatewayFailureValid(turn) &&
      turn.gatewayRecovery?.version === gatewayContinuationVersion &&
      turn.gatewayRecovery.nextTurnId
    ) &&
    !disputeContinuationReady(turn)
  );
}

export function canPlanDisputedTurn(task, turn) {
  return !!(
    task.projectSeries &&
    !task.closed &&
    task.turns.at(-1)?.id === turn?.id &&
    turn.status === 'failed' &&
    !turn.excluded &&
    disputedEvaluationComplete(turn)
  );
}
