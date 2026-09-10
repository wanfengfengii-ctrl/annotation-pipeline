import fs from 'node:fs';
import path from 'node:path';
import { digest } from './solo-records.mjs';

// Explicit exceptions bind one unchanged historical record and its exact failed
// audit. They never change the audit result or authorize another session/round.
export function permissionAdmission(context, root) {
  const file = path.join(root, 'permission-admissions.json');
  if (!fs.existsSync(file)) return null;
  const approvals = JSON.parse(fs.readFileSync(file));
  if (approvals.version !== 1 || !approvals.entries)
    throw Error('权限例外授权清单无效');
  const key = context.taskId + ':' + context.turnId;
  const entry = approvals.entries[key];
  if (!entry) return null;
  const { permission } = context;
  if (
    entry.authorizedByUser !== true ||
    !entry.userInstruction?.trim() ||
    !entry.authorizedAt ||
    permission.passed ||
    !permission.modeVerified ||
    permission.denialCount < 1 ||
    permission.findings.length !== permission.denialCount ||
    [
      'taskId',
      'turnId',
      'sessionId',
      'promptId',
      'traceExportSha256',
      'nativeManifestSha256',
      'attachmentSha256',
    ].some((field) => !context[field] || entry[field] !== context[field]) ||
    entry.permissionChecksVersion !== permission.checksVersion ||
    entry.findingsSha256 !== digest(permission.findings)
  )
    throw Error('权限例外与当前记录、原始轨迹或实际报错不符');
  return { key, ...entry };
}
