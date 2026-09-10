export const soloStatusLabels = {
  not_uploaded: '未上传',
  prepared: '待上传',
  submitting: '上传中',
  uncertain: '待核对',
  submitted: '已提交，待质检',
  passed: '质检通过',
  needs_fix: '待返修',
  discarded: '已废弃',
  blocked: '暂缓上传',
  held: '禁止上传',
};
export const soloStatusCodes = Object.keys(soloStatusLabels);
const validKey = (key) => /^[\w-]+:[\w-]+$/.test(key);

// Display projection only: never expose private ledger, local paths or credentials.
export function soloStatusSnapshot(
  ledger,
  holds,
  checkedAt = new Date().toISOString(),
) {
  const entries = {};
  const blocked = new Map(
    (ledger.lastPlan?.blocked || []).map((x) => [x.key, x.reason]),
  );
  const keys = new Set([
    ...Object.keys(ledger.entries || {}),
    ...Object.keys(holds.entries || {}),
    ...blocked.keys(),
  ]);
  for (const key of keys) {
    if (!validKey(key)) throw Error('上传状态记录标识无效');
    const entry = ledger.entries?.[key] || {};
    const hold = holds.entries?.[key];
    const remoteId =
      /^\d+$/.test(String(entry.remoteId)) && Number(entry.remoteId) > 0
        ? Number(entry.remoteId)
        : null;
    const remote = {
      SUBMITTED: 'submitted',
      QC_PASSED: 'passed',
      PENDING_FIX: 'needs_fix',
      DISCARDED: 'discarded',
    }[entry.remoteStatus];
    const status = hold
      ? 'held'
      : remoteId
        ? remote || 'uncertain'
        : ['submitting', 'uncertain'].includes(entry.state)
          ? entry.state
          : blocked.has(key)
            ? 'blocked'
            : entry.state === 'prepared'
              ? 'prepared'
              : 'not_uploaded';
    entries[key] = {
      status,
      remoteId,
      remoteStatus: remoteId ? entry.remoteStatus || '' : '',
      reason: String(
        hold?.reason ||
          (remoteId ? entry.remoteReason : blocked.get(key)) ||
          '',
      ).slice(0, 2000),
      updatedAt:
        hold?.markedAt || entry.updatedAt || ledger.lastPreparedAt || checkedAt,
    };
  }
  return validateSoloStatusSnapshot({ version: 1, checkedAt, entries });
}
export function validateSoloStatusSnapshot(value) {
  if (
    value?.version !== 1 ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    !value.entries ||
    typeof value.entries !== 'object' ||
    Array.isArray(value.entries) ||
    Object.keys(value.entries).length > 10000
  )
    throw Error('上传状态快照无效');
  const entries = {};
  for (const [key, row] of Object.entries(value.entries)) {
    if (
      !validKey(key) ||
      !soloStatusCodes.includes(row?.status) ||
      (row.remoteId !== null &&
        (!Number.isSafeInteger(row.remoteId) || row.remoteId < 1)) ||
      typeof row.reason !== 'string' ||
      row.reason.length > 2000 ||
      !Number.isFinite(Date.parse(row.updatedAt)) ||
      !['', 'SUBMITTED', 'QC_PASSED', 'PENDING_FIX', 'DISCARDED'].includes(
        row.remoteStatus,
      )
    )
      throw Error('上传状态字段无效');
    entries[key] = {
      status: row.status,
      remoteId: row.remoteId,
      remoteStatus: row.remoteStatus,
      reason: row.reason,
      updatedAt: row.updatedAt,
    };
  }
  return {
    version: 1,
    checkedAt: new Date(value.checkedAt).toISOString(),
    entries,
  };
}
