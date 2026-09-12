import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function recoveryRequests(action, id) {
  const token =
    process.env.RUNNER_TOKEN ||
    (fs.existsSync(path.join(root, '.dev.vars'))
      ? fs
          .readFileSync(path.join(root, '.dev.vars'), 'utf8')
          .match(/^RUNNER_TOKEN=(.+)$/m)?.[1]
      : null);
  if (!token) return [];
  const r = await fetch(
    (process.env.PIPELINE_API_URL || 'http://localhost:3000') +
      '/api/solo-upload/recovery',
    {
      method: action === 'ack' ? 'POST' : 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      ...(action === 'ack' ? { body: JSON.stringify({ action, id }) } : {}),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (r.status === 404) return [];
  if (!r.ok) throw Error('恢复意图读取失败：' + r.status);
  return (await r.json()).requests || [];
}
