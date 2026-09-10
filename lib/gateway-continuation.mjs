import workflow from '../rules/workflow.json' with { type: 'json' };
import { questionRoot } from './question-session.mjs';

export const gatewayContinuationVersion = '2026-09-10.gateway-504-continue1';
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function gatewayFailureValid(turn) {
  const failure = turn?.gatewayFailure;
  return !!(
    failure?.version === gatewayContinuationVersion &&
    failure.status === 504 &&
    turn.executionOutcome === 'error' &&
    turn.permissionAudit?.passed === true &&
    turn.traceExport?.verified === true &&
    sha(failure.traceSha256) &&
    sha(failure.eventSha256) &&
    failure.traceSha256 === turn.traceExport.sha256 &&
    failure.promptId === turn.promptId &&
    failure.sessionId === turn.sessionId &&
    !!turn.promptId &&
    !!turn.sessionId
  );
}
export function isGatewayContinuation(turn) {
  const marker = turn?.gatewayContinuation;
  return !!(
    marker?.version === gatewayContinuationVersion &&
    turn.prompt === '继续' &&
    turn.continuationOf &&
    !turn.repairOf &&
    marker.failedTurnId === turn.continuationOf &&
    marker.failedPromptId &&
    marker.sessionId &&
    marker.containerId &&
    sha(marker.traceSha256)
  );
}
export function gatewayContinuationContext(task, turn) {
  if (!turn.gatewayContinuation) return null;
  const index = task.turns.findIndex((r) => r.id === turn.id);
  const previous = task.turns[index - 1];
  const marker = turn.gatewayContinuation;
  if (
    !isGatewayContinuation(turn) ||
    !previous ||
    previous.status !== 'failed' ||
    previous.excluded ||
    !gatewayFailureValid(previous) ||
    previous.id !== turn.continuationOf ||
    previous.gatewayRecovery?.nextTurnId !== turn.id ||
    marker.failedPromptId !== previous.promptId ||
    marker.sessionId !== previous.sessionId ||
    marker.traceSha256 !== previous.traceExport.sha256 ||
    marker.containerId !== previous.container?.containerId ||
    questionRoot(task, turn) !== questionRoot(task, previous) ||
    !previous.automation?.preparation?.value ||
    previous.automation?.policy?.accepted !== true
  )
    throw Error('504 继续缺少紧邻失败轮、原生身份或原题审核依据');
  return {
    previous,
    evaluationPrompt: previous.evaluationPrompt || previous.prompt,
    acceptance: previous.automation.preparation.value.acceptance,
  };
}
export function planGatewayContinuation(
  task,
  failed,
  { id, callCount, now = new Date().toISOString() },
) {
  if (
    task.closed ||
    task.turns.at(-1)?.id !== failed.id ||
    failed.status !== 'failed' ||
    failed.excluded ||
    !gatewayFailureValid(failed) ||
    failed.gatewayRecovery ||
    task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    ) ||
    !Number.isInteger(callCount) ||
    callCount >= workflow.sessionLimits.maxCalls ||
    task.container?.status !== 'running' ||
    task.container.questionId !== questionRoot(task, failed) ||
    task.container.containerId !== failed.container?.containerId ||
    task.container.sessionId !== failed.sessionId ||
    !failed.automation?.preparation?.value ||
    failed.automation?.policy?.accepted !== true ||
    task.turns.some(
      (r) =>
        questionRoot(task, r) === questionRoot(task, failed) &&
        r.permissionAudit?.passed === false,
    )
  )
    return null;
  return {
    id,
    prompt: '继续',
    continuationOf: failed.id,
    questionRootId: questionRoot(task, failed),
    roundNumber:
      task.turns.filter(
        (r) => questionRoot(task, r) === questionRoot(task, failed),
      ).length + 1,
    category: failed.category,
    difficulty: failed.difficulty,
    stack: failed.stack,
    evaluationPrompt: failed.evaluationPrompt || failed.prompt,
    status: 'queued',
    createdAt: now,
    autoFollowup: true,
    gatewayContinuation: {
      version: gatewayContinuationVersion,
      failedTurnId: failed.id,
      failedPromptId: failed.promptId,
      sessionId: failed.sessionId,
      containerId: task.container.containerId,
      traceSha256: failed.traceExport.sha256,
    },
  };
}

// Successful recovery contributes one business question to the mix, never an
// extra Feature/Bug because the user sent a transport-recovery message.
export function businessTurnId(task, turn) {
  let current = turn;
  const seen = new Set();
  while (isGatewayContinuation(current) && !seen.has(current.id)) {
    seen.add(current.id);
    const prior = task.turns.find((r) => r.id === current.continuationOf);
    if (!prior) break;
    current = prior;
  }
  return current.id;
}

export function recoveryRepairChecks(task, turn, previousTurn) {
  const original =
    task.turns.find((r) => r.id === businessTurnId(task, turn)) || turn;
  const previous = original.repairOf
    ? task.turns.find((r) => r.id === original.repairOf)
    : previousTurn;
  const decision = previous?.automation?.next?.value;
  return Array.isArray(original.repairCheckIds)
    ? original.repairCheckIds
    : decision?.prompt === (original.requestedPrompt || original.prompt)
      ? decision.repairCheckIds || []
      : [];
}
