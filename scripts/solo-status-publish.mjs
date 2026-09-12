import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { soloStatusSnapshot } from '../lib/solo-upload-status.mjs';
import { uploadHolds } from './solo-upload-holds.mjs';
import { savePrivateJSON } from './solo-client.mjs';
const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const root = path.join(project, '.runner/solo-upload');
export async function publishSoloStatus(ledger) {
  const schedulePath = path.join(root, 'schedule.json');
  const schedule = fs.existsSync(schedulePath)
    ? JSON.parse(fs.readFileSync(schedulePath, 'utf8'))
    : {};
  const snapshot = soloStatusSnapshot(
    ledger,
    uploadHolds(),
    new Date().toISOString(),
    schedule,
  );
  savePrivateJSON(path.join(root, 'display-status.json'), snapshot);
  const token = fs
    .readFileSync(path.join(project, '.dev.vars'), 'utf8')
    .match(/^RUNNER_TOKEN=(.+)$/m)?.[1];
  if (!token) throw Error('上传状态同步缺少本机认证');
  const response = await fetch('http://localhost:3000/api/solo-upload', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw Error('上传状态已保存本地，页面同步失败：' + response.status);
  return { ...(await response.json()), checkedAt: snapshot.checkedAt };
}
