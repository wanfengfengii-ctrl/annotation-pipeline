import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSoloLock } from './solo-lock.mjs';
import { savePrivateJSON } from './solo-client.mjs';
import { recordKey } from './solo-records.mjs';

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.runner/solo-upload',
);
const validKey = (key) =>
  typeof key === 'string' && /^[\w-]+:[\w-]+$/.test(key);

export function uploadHolds(root = defaultRoot) {
  const file = path.join(root, 'upload-holds.json');
  if (!fs.existsSync(file)) return { version: 1, entries: {} };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.version !== 1 ||
    !value.entries ||
    Object.entries(value.entries).some(
      ([key, entry]) =>
        !validKey(key) || entry.blocked !== true || !entry.reason?.trim(),
    )
  )
    throw Error('SOLO 禁止上传标记无效，先核对标记文件');
  return value;
}

export function assertUploadNotHeld(row, root = defaultRoot) {
  const hold = uploadHolds(root).entries[recordKey(row)];
  if (hold) throw Error('用户已标记禁止上传 SOLO：' + hold.reason);
}

export function applyUploadHolds(rows, root = defaultRoot) {
  const { entries } = uploadHolds(root);
  return rows.map((row) => {
    const hold = entries[recordKey(row)];
    return hold ? { ...row, eligible: false, uploadHold: hold } : row;
  });
}

export async function blockUpload(key, reason, root = defaultRoot) {
  if (!validKey(key) || typeof reason !== 'string' || !reason.trim())
    throw Error('禁止上传标记需要固定记录 ID 和原因');
  return withSoloLock(path.join(root, 'journal.lock'), () => {
    const ledgerPath = path.join(root, 'ui-state.json');
    const entry = fs.existsSync(ledgerPath)
      ? JSON.parse(fs.readFileSync(ledgerPath)).entries?.[key]
      : null;
    if (['submitting', 'uncertain'].includes(entry?.state))
      throw Error('该条提交结果尚未明确，请先查回执，再标记后续禁止上传');
    const holds = uploadHolds(root);
    holds.entries[key] = {
      blocked: true,
      reason: reason.trim(),
      markedAt: new Date().toISOString(),
    };
    savePrivateJSON(path.join(root, 'upload-holds.json'), holds);
    return { key, ...holds.entries[key] };
  });
}
