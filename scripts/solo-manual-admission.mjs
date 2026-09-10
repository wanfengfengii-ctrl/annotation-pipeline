import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, recordKey } from './solo-records.mjs';
import { createSoloNativeAttachment } from './solo-native-attachment.mjs';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.runner/solo-upload',
);

// An explicit, finite user approval for unchanged historical records. This never
// changes their actual export provenance or grants an exception to new records.
export function applyManualAdmissions(rows, admissionRoot = root) {
  const file = path.join(admissionRoot, 'manual-admissions.json');
  if (!fs.existsSync(file)) return rows;
  const approvals = JSON.parse(fs.readFileSync(file));
  if (
    approvals.version !== 1 ||
    !approvals.userInstruction ||
    !approvals.entries
  )
    throw Error('历史记录授权清单无效');
  return rows.map((row) => {
    const approval = approvals.entries[recordKey(row)];
    if (!approval || row.uploadHold || row.nativeIdIssue) return row;
    try {
      if (
        approval.sourceValuesDigest !== digest(row.values) ||
        approval.authorizedByUser !== true ||
        approval.wordingPassed !== true ||
        !approval.evidence?.length
      )
        throw Error('历史记录内容变化或缺少逐题审核');
      for (const evidence of approval.evidence)
        if (digest(fs.readFileSync(evidence.path)) !== evidence.sha256)
          throw Error('历史证据内容变化');
      if (
        approval.promptId !== row.nativeIdentity?.promptId ||
        approval.sessionId !== row.nativeIdentity?.sessionId
      )
        throw Error('原生标识与历史授权不符');
      if (digest(approval.values) !== approval.approvedValuesDigest)
        throw Error('已审核字段摘要不符');
      return {
        ...row,
        values: approval.values,
        eligible: true,
        manualAdmission: approval,
      };
    } catch (e) {
      return { ...row, eligible: false, nativeIdIssue: e.message };
    }
  });
}

export function manualAttachment(row, knownSecrets) {
  const approval = row.manualAdmission;
  if (!approval || digest(row.values) !== approval.approvedValuesDigest)
    throw Error('缺少本条历史上传授权');
  const archive = createSoloNativeAttachment({
    ...approval.native,
    turnId: row.turnId,
    promptId: approval.promptId,
    sessionId: approval.sessionId,
    knownSecrets,
  });
  if (archive.sha256 !== approval.attachmentSha256)
    throw Error('已审核历史附件发生变化');
  return archive;
}
