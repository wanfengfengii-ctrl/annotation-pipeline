import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const checkpointVersion = '2026-09-10.stages1';
export const checkpointDigest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function readEvidence(file, dir) {
  const root = realpathSync(dir),
    absolute = path.resolve(file);
  if (
    !absolute.startsWith(root + path.sep) ||
    !realpathSync(absolute).startsWith(root + path.sep)
  )
    throw Error('阶段证据超出本题目录');
  for (let p = absolute; p !== root; p = path.dirname(p))
    if (lstatSync(p).isSymbolicLink()) throw Error('阶段证据不能是符号链接');
  if (!lstatSync(absolute).isFile()) throw Error('阶段证据不是文件');
  return readFileSync(absolute);
}
// Seal only completed native Codex output. The caller runs the domain validators
// before sealing and again after restoring; a checkpoint never implies approval.
export function sealStage(stage, saved, key, dir, extraFiles = []) {
  const suffix = '.' + stage + '.events.jsonl';
  if (
    saved?.engine !== 'codex-cli' ||
    !saved.threadId ||
    !saved.finishedAt ||
    !saved.tracePath?.endsWith(suffix)
  )
    throw Error('阶段完成记录不完整');
  const outputPath =
    saved.tracePath.slice(0, -'.events.jsonl'.length) + '.json';
  const bytes = readEvidence(saved.tracePath, dir),
    output = readEvidence(outputPath, dir);
  const events = bytes
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const starts = events.filter((e) => e.type === 'thread.started');
  const last = events
    .filter(
      (e) => e.type === 'item.completed' && e.item?.type === 'agent_message',
    )
    .at(-1);
  if (
    starts.length !== 1 ||
    starts[0].thread_id !== saved.threadId ||
    events.at(-1)?.type !== 'turn.completed' ||
    events.some((e) => ['error', 'turn.failed'].includes(e.type)) ||
    !isDeepStrictEqual(JSON.parse(last?.item.text), JSON.parse(output))
  )
    throw Error('阶段结果与完成轨迹不一致');
  const references = [...new Set(extraFiles)]
    .sort()
    .map((file) => ({ path: file, sha256: hash(readEvidence(file, dir)) }));
  return {
    references,
    version: checkpointVersion,
    key,
    stage,
    valueHash: checkpointDigest(saved),
    files: [
      { path: saved.tracePath, sha256: hash(bytes) },
      { path: outputPath, sha256: hash(output) },
    ],
  };
}
export function restoreStage(stage, saved, receipt, key, dir) {
  try {
    if (
      !receipt ||
      receipt.version !== checkpointVersion ||
      receipt.stage !== stage ||
      receipt.key !== key ||
      receipt.valueHash !== checkpointDigest(saved)
    )
      return null;
    const current = sealStage(
      stage,
      saved,
      key,
      dir,
      (receipt.references || []).map((f) => f.path),
    );
    return isDeepStrictEqual(current, receipt) ? structuredClone(saved) : null;
  } catch {
    return null;
  }
}
