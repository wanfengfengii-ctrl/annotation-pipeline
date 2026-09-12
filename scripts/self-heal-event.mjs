import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, saveJSON } from './self-heal-io.mjs';

export function recordExternalFault(root, input) {
  if (
    input?.source !== 'solo-upload' ||
    !/^[a-zA-Z0-9:._+-]{1,160}$/.test(input.id || '') ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 6000 ||
    !Array.isArray(input.keys) ||
    input.keys.length > 1000 ||
    input.keys.some((k) => !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(k))
  )
    throw Error('外部故障事件格式无效');
  const file = path.join(root, '.runner/self-heal/external-events.json'),
    events = readJSON(file, {}),
    id = input.source + ':' + input.id;
  events[id] = {
    ...input,
    keys: [...new Set(input.keys)],
    reportedAt: events[id]?.reportedAt || new Date().toISOString(),
  };
  saveJSON(file, events);
  return { recorded: true, id };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] !== '--report')
    throw Error('使用 --report 诊断JSON文件路径');
  console.log(
    JSON.stringify(
      recordExternalFault(
        path.resolve(import.meta.dirname, '..'),
        readJSON(process.argv[3]),
      ),
    ),
  );
}
