export function batchRevision(run) {
  return JSON.stringify([
    run.status,
    run.attemptId || '',
    run.startedAt || '',
    run.finishedAt || '',
    run.leaseUntil || '',
    (run.members || []).map((m) => [m.key, m.sourceDigest, m.packetDigest]),
  ]);
}
export function batchNeedsReconciliation(run, now = new Date()) {
  return (
    run.status === 'running' &&
    (!Number.isFinite(Date.parse(run.leaseUntil)) ||
      Date.parse(run.leaseUntil) <= now.getTime())
  );
}
export function canRequestBatchRecovery(run, now = new Date()) {
  return (
    [
      'waiting_resume',
      'waiting_login',
      'waiting_window',
      'blocked',
      'failed',
    ].includes(run.status) || batchNeedsReconciliation(run, now)
  );
}
export function uploadBatchSnapshot(schedule, entries) {
  return Object.entries(schedule.runs || {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 100)
    .map(([slot, run]) => {
      const rows = (run.members || []).map((m) => {
        const e = entries[m.key] || {};
        const status = e.status || 'not_uploaded';
        const next = ['submitting', 'uncertain'].includes(status)
          ? '仅查询远端回执'
          : status === 'held'
            ? '保留禁止上传标记'
            : status === 'needs_fix'
              ? '依据原回执返修'
              : ['submitted', 'passed', 'discarded'].includes(status)
                ? '保留已提交回执'
                : status === 'blocked'
                  ? '核对缺失材料或字段，重新准备'
                  : run.status === 'waiting_login'
                    ? '登录恢复后续传本批'
                    : run.status === 'waiting_window'
                      ? '等待白天上传窗口'
                      : '重新核验后由原上传任务处理';
        return {
          key: m.key,
          status,
          reason: e.reason || '',
          remoteId: e.remoteId || null,
          next,
        };
      });
      const counts = {};
      for (const row of rows)
        counts[row.status] = (counts[row.status] || 0) + 1;
      return {
        slot,
        revision: batchRevision(run),
        status: run.status,
        reasonCode: run.reasonCode || '',
        pauseReason: run.pauseReason || '',
        startedAt: run.startedAt || run.createdAt,
        finishedAt: run.finishedAt || null,
        leaseUntil: run.leaseUntil || null,
        attempts: run.attempts?.length || 0,
        counts,
        rows,
        canRequestRecovery: canRequestBatchRecovery(run) && rows.length > 0,
        recoveryRequestedAt: run.recoveryRequestedAt || null,
      };
    });
}
export function applyBatchRecovery(state, request, now = new Date()) {
  const run = state.runs?.[request.slot];
  if (
    !run ||
    request.revision !== batchRevision(run) ||
    !canRequestBatchRecovery(run, now) ||
    !run.members?.length
  )
    return false;
  run.recoveryRequestedAt = now.toISOString();
  // Does not claim a lease, alter membership or clear any submission state.
  return true;
}
