import {
  uploadBatchSnapshot,
  canRequestBatchRecovery,
} from './upload-batches.mjs';
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
  schedule = {},
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
        ? entry.receiptVerified === true
          ? remote || 'uncertain'
          : 'uncertain'
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
      ...(entry.displayIdentity ? { identity: entry.displayIdentity } : {}),
      updatedAt:
        hold?.markedAt || entry.updatedAt || ledger.lastPreparedAt || checkedAt,
    };
  }
  return validateSoloStatusSnapshot({
    version: 1,
    checkedAt,
    entries,
    batches: uploadBatchSnapshot(schedule, entries),
  });
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
      ...(row.identity &&
      ['sessionId', 'messageUuid', 'promptId'].every((k) =>
        /^[\w-]{1,128}$/.test(row.identity[k] || ''),
      )
        ? {
            identity: {
              sessionId: row.identity.sessionId,
              messageUuid: row.identity.messageUuid,
              promptId: row.identity.promptId,
            },
          }
        : {}),
    };
  }
  return {
    version: 1,
    checkedAt: new Date(value.checkedAt).toISOString(),
    entries,
    ...(value.batches
      ? { batches: validateBatches(value.batches, entries) }
      : {}),
  };
}
function validateBatches(batches, entries) {
  if (!Array.isArray(batches) || batches.length > 100)
    throw Error('上传批次快照无效');
  return batches.map((b) => {
    if (
      typeof b.slot !== 'string' ||
      !Number.isFinite(Date.parse(b.slot)) ||
      typeof b.revision !== 'string' ||
      b.revision.length > 100000 ||
      !Array.isArray(b.rows) ||
      b.rows.length > 1000
    )
      throw Error('上传批次字段无效');
    const rows = b.rows.map((r) => {
      if (!validKey(r.key)) throw Error('批次成员无效');
      return {
        key: r.key,
        status: entries[r.key]?.status || 'not_uploaded',
        reason: entries[r.key]?.reason || '',
        remoteId: entries[r.key]?.remoteId || null,
        next: String(r.next || '').slice(0, 200),
      };
    });
    const counts = {};
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    return {
      slot: b.slot,
      revision: b.revision,
      status: String(b.status || '').slice(0, 40),
      reasonCode: String(b.reasonCode || '').slice(0, 100),
      pauseReason: String(b.pauseReason || '').slice(0, 500),
      startedAt: b.startedAt || null,
      finishedAt: b.finishedAt || null,
      leaseUntil: Number.isFinite(Date.parse(b.leaseUntil))
        ? b.leaseUntil
        : null,
      attempts: Number.isSafeInteger(b.attempts) ? b.attempts : 0,
      rows,
      counts,
      recoveryRequestedAt: b.recoveryRequestedAt || null,
      canRequestRecovery:
        b.canRequestRecovery === true &&
        canRequestBatchRecovery(b) &&
        rows.length > 0,
    };
  });
}
