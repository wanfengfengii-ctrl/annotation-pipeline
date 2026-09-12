export const productionHistoryVersion = '2026-09-12.production1';
// Called after the finish route's token/idempotency checks, before replacing
// automation. Successful revalidation never creates a second new-data record.
export function recordDeliveryHistory(
  turn,
  result,
  now = new Date().toISOString(),
) {
  if (
    result.success !== true ||
    result.automation?.delivery?.value?.passed !== true
  )
    return turn.productionHistory;
  const prior = turn.productionHistory;
  const wasDelivered =
    !!prior?.firstObservedAt ||
    turn.automation?.delivery?.value?.passed === true;
  const firstDeliveredAt =
    prior?.firstDeliveredAt ||
    (wasDelivered ? turn.automation?.delivery?.finishedAt || null : now);
  return {
    version: productionHistoryVersion,
    firstObservedAt: prior?.firstObservedAt || now,
    firstDeliveredAt,
    historicalBaseline: prior?.historicalBaseline ?? wasDelivered,
    revalidationCount: (prior?.revalidationCount || 0) + Number(wasDelivered),
    lastDeliveredAt: now,
    events: [
      ...(prior?.events || []),
      { at: now, kind: wasDelivered ? 'revalidation' : 'first-delivery' },
    ],
  };
}
