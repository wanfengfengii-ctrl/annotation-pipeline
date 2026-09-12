import { createHash } from 'node:crypto';

export const recoveryConditionsVersion = '2026-09-12.recovery-conditions1';
export const conditionDigest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only prerequisites, never API heartbeat, retry counters or mutable error prose.
export function projectRecoveryConditions(task, turn, revision) {
  const c = task.container || {};
  return conditionDigest({
    version: recoveryConditionsVersion,
    revision: revision || null,
    taskId: task.id,
    turnId: turn.id,
    closed: !!task.closed,
    container: [
      c.containerId,
      c.questionId,
      c.status,
      c.sessionId,
      c.pending?.turnId,
      c.pending?.phase,
      c.pending?.promptHash,
      c.traceExport?.verified,
      c.traceExport?.sha256,
      c.terminal?.runId,
      c.terminalFinalization?.receiptSha256,
      c.terminalFinalization?.completedAt,
    ],
    turns: task.turns.map((r) => [
      r.id,
      !!r.excluded,
      !!r.recoveryBlocked,
      r.promptId,
      r.sessionId,
      r.executionOutcome,
      r.permissionAudit?.passed,
      r.traceExport?.verified,
      r.traceExport?.sha256,
      r.automation?.archive?.manifestSha256,
      r.receipt,
      r.humanReview?.receipt,
    ]),
  });
}

export function selfHealConditions(incident, snapshot) {
  const task = snapshot.tasks.find((t) => t.id === incident.taskId);
  const turn = task?.turns.find((r) => r.id === incident.turnId);
  return conditionDigest({
    version: recoveryConditionsVersion,
    signature: incident.signature,
    revision:
      snapshot.recoveryRevision || snapshot.config.recoveryRevision || null,
    inputs: turn ? projectRecoveryConditions(task, turn) : null,
    stage: turn?.stage,
    outcome: turn?.executionOutcome,
    report: turn?.automation?.runtimeVerification?.reportSha256,
    evidence:
      snapshot.health.incidents?.find(
        (i) =>
          i.taskId === incident.taskId &&
          i.turnId === incident.turnId &&
          i.stage === incident.stage,
      )?.evidenceKey || null,
    progress:
      snapshot.health.progress?.[incident.taskId + ':' + incident.turnId]
        ?.lastProgressAt || null,
  });
}
