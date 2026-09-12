import { createHash } from 'node:crypto';
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const observerHandoffVersion = '2026-09-12.observer-handoff1';
export function queueObserverHandoff(
  task,
  turn,
  request,
  now = new Date().toISOString(),
) {
  const c = task.container;
  if (supersededObserver(turn, request.jobToken)) return false;
  if (
    !turn ||
    task.closed ||
    turn.status !== 'running' ||
    turn.stage !== 'claude' ||
    turn.jobToken !== request.jobToken ||
    !request.jobToken ||
    turn.excluded ||
    turn.receipt ||
    turn.recoveryBlocked ||
    !turn.claudeAttempts?.length ||
    !c ||
    c.status !== 'running' ||
    c.containerId !== request.containerId ||
    (c.sessionId || null) !== request.sessionId ||
    c.questionId !== (turn.questionRootId || turn.id) ||
    c.terminal?.runId !== request.terminalRunId ||
    !request.terminalRunId ||
    !/^[a-f0-9]{64}$/.test(request.promptHash || '')
  )
    throw Error('当前轮次不满足原终端观察交接条件');
  turn.observerHandoff = {
    version: observerHandoffVersion,
    previousJobTokenHash: tokenHash(request.jobToken),
    containerId: request.containerId,
    sessionId: request.sessionId,
    terminalRunId: request.terminalRunId,
    promptHash: request.promptHash,
    queuedAt: now,
  };
  delete turn.jobToken;
  turn.status = 'queued';
  return true;
}
export const supersededObserver = (turn, token) =>
  !!(
    token &&
    turn?.observerHandoff?.version === observerHandoffVersion &&
    turn.observerHandoff.previousJobTokenHash === tokenHash(token)
  );
