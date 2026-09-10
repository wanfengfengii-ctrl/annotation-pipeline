import { questionRoot } from './question-session.mjs';
import { shouldFinishSession } from './project-series.mjs';

// A queued independent question must not keep its completed predecessor alive.
// This is admission only: the owner also checks actual native completion twice.
export function sessionFinalization(task) {
  const container = task.container;
  if (!container?.questionId) return null;
  if (task.turns.some((r) => r.recoveryBlocked || r.status === 'running'))
    return null;
  const turns = task.turns.filter(
    (r) => questionRoot(task, r) === container.questionId,
  );
  if (!turns.length || turns.some((r) => r.status === 'queued')) return null;
  const last = turns.at(-1),
    next = last.automation?.next?.value?.action;
  const frozenTask = { ...task, turns };
  const identity = {
    questionId: container.questionId,
    turnId: last.id,
    containerId: container.containerId,
  };
  if (container.status === 'removed')
    return { ...identity, reason: 'final-receipt' };
  // Explicit closure can include a rejected question that never reached Claude.
  // The owner still proves the native session is idle before sending /exit.
  if (task.closed) return { ...identity, reason: 'operator-closed' };
  if (last.status === 'failed') {
    if (
      last.traceExport?.verified !== true ||
      !last.promptId ||
      !last.sessionId
    )
      return null;
    if (
      last.executionOutcome === 'error' &&
      last.permissionAudit?.passed === true
    )
      return {
        ...identity,
        failedTurnId: last.id,
        reason: 'completed-provider-error',
      };
    if (
      ['complete', 'error'].includes(last.executionOutcome) &&
      last.permissionAudit?.passed === false
    )
      return {
        ...identity,
        failedTurnId: last.id,
        reason: 'completed-quality-failure',
      };
    return null;
  }
  if (next === 'advance' || shouldFinishSession(frozenTask))
    return {
      ...identity,
      reason: next === 'needs_input' ? 'needs-attention' : 'completed-session',
    };
  return null;
}
