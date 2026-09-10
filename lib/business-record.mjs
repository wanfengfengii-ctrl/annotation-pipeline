import {
  gatewayContinuationContext,
  isGatewayContinuation,
} from './gateway-continuation.mjs';

export const businessRecordVersion = '2026-09-10.business-recovery1';
export function nativeRound(task, turn) {
  const turns = task.turns || [];
  const index = turns.findIndex((r) => r.id === turn.id);
  if (index >= 0 && turn.questionRootId)
    return turns
      .slice(0, index + 1)
      .filter((r) => r.questionRootId === turn.questionRootId).length;
  return turn.roundNumber || (index >= 0 ? index + 1 : '');
}

// A record owns the business question; its result still belongs to the real
// invocation that produced it. Never manufacture a Turn with mixed identities.
export function businessRecord(task, input) {
  const turns = task.turns || [];
  let origin = input;
  const seen = new Set();
  while (origin.gatewayContinuation) {
    if (seen.has(origin.id)) throw Error('504 业务题关联成环');
    seen.add(origin.id);
    origin = gatewayContinuationContext(task, origin).previous;
  }
  const chain = [origin];
  seen.clear();
  let result = origin;
  while (result.gatewayRecovery) {
    if (seen.has(result.id) || chain.length >= 10)
      throw Error('504 继续链超出实际调用上限');
    seen.add(result.id);
    const next = turns.find((r) => r.id === result.gatewayRecovery.nextTurnId);
    if (
      !next ||
      !isGatewayContinuation(next) ||
      gatewayContinuationContext(task, next).previous.id !== result.id
    )
      throw Error('504 继续链缺少原始关联');
    if (
      next.excluded ||
      (next.sessionId && next.sessionId !== origin.sessionId) ||
      (next.container &&
        next.container.containerId !== origin.container?.containerId)
    )
      throw Error('504 继续结果已排除或原生会话身份不符');
    if (
      next.evaluationPrompt !== (origin.evaluationPrompt || origin.prompt) ||
      next.category !== origin.category ||
      next.difficulty !== origin.difficulty ||
      (next.automation?.preparation?.value &&
        JSON.stringify(next.automation.preparation.value.acceptance) !==
          JSON.stringify(origin.automation?.preparation?.value?.acceptance)) ||
      (['review', 'submitted'].includes(next.status) &&
        !next.automation?.preparation?.value)
    )
      throw Error('504 继续的评分目标或验收要求与原题不一致');
    chain.push(next);
    result = next;
  }
  if (input.id !== origin.id && !chain.some((r) => r.id === input.id))
    throw Error('504 结果不属于当前原题');
  const recovery =
    chain.length > 1
      ? {
          version: businessRecordVersion,
          originTurnId: origin.id,
          resultTurnId: result.id,
          sessionId: origin.sessionId,
          containerId: origin.container?.containerId,
          steps: chain.map((r) => ({
            turnId: r.id,
            messageUuid: r.promptId || '',
            round: nativeRound(task, r),
            eventSha256: r.gatewayFailure?.eventSha256 || '',
            traceSha256: r.traceExport?.sha256 || '',
          })),
          finalTraceSha256:
            result.automation?.submission?.finalization?.traceExport?.sha256 ||
            '',
        }
      : undefined;
  return { origin, result, chain, recovery };
}

export function businessRecordOrigins(task) {
  return (task.turns || []).filter((r) => {
    if (!r.gatewayContinuation) return true;
    try {
      return businessRecord(task, r).origin.id === r.id;
    } catch {
      return true;
    } // Invalid associations remain visible and blocked.
  });
}

export function assertRecordSource(task, row) {
  const origin = task?.turns.find((r) => r.id === row.turnId);
  if (!origin) throw Error('业务原题已缺失');
  const record = businessRecord(task, origin);
  if (
    (row.resultTurnId || row.turnId) !== record.result.id ||
    JSON.stringify(row.recovery) !== JSON.stringify(record.recovery)
  )
    throw Error('业务题的继续结果或最终轨迹已变化，请重新读取记录');
  return record;
}
