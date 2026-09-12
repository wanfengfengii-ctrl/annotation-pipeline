const stamp = (v) => (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
export function unionDuration(intervals) {
  const sorted = intervals
    .filter(([a, b]) => a !== null && b !== null && b >= a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    end = -Infinity;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}
// Wall time and summed stage costs are separate: overlapping work is counted
// only once in activeMs. Unknown history is not manufactured as a duration.
export function taskTiming(
  attempts,
  firstDeliveredAt,
  now = new Date().toISOString(),
) {
  const production = attempts.filter(
    (a) => !a.outcome?.startsWith('project-replan-'),
  );
  const starts = production
    .map((a) => stamp(a.startedAt))
    .filter((v) => v !== null);
  const start = starts.length ? Math.min(...starts) : null;
  const delivered = stamp(firstDeliveredAt),
    observed = stamp(now);
  const end = delivered ?? observed;
  const wallMs =
    start !== null && end !== null && end >= start ? end - start : null;
  const intervals = [],
    queues = [],
    stages = [];
  let missingIntervals = 0;
  for (const a of production)
    for (const s of a.stages) {
      const began = stamp(s.startedAt),
        finished = stamp(s.finishedAt);
      if (delivered !== null && began !== null && began > delivered) continue;
      const stop = finished ?? (a.finishedAt ? null : observed);
      if (began === null || stop === null) missingIntervals++;
      else intervals.push([began, Math.min(stop, end)]);
      const queued = stamp(s.queuedAt);
      if (queued !== null && began !== null)
        queues.push([queued, Math.min(began, end)]);
      stages.push({
        ...s,
        attemptId: a.attemptId,
        release: a.release,
        ongoing: !s.finishedAt && !a.finishedAt,
      });
    }
  const activeMs = unionDuration(intervals),
    queueMs = unionDuration(queues);
  return {
    startedAt: start === null ? null : new Date(start).toISOString(),
    firstDeliveredAt: delivered === null ? null : firstDeliveredAt,
    wallMs,
    activeMs,
    queueMs,
    missingIntervals,
    unaccountedMs:
      wallMs === null || missingIntervals
        ? null
        : Math.max(0, wallMs - unionDuration([...intervals, ...queues])),
    // The remainder includes orchestration gaps; it is not all "recovery".
    attempts: production.length,
    stages,
    repeatedStages: stages.filter(
      (s, i) => stages.findIndex((x) => x.stage === s.stage) !== i,
    ).length,
  };
}
