import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const list = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
// Read only runner-owned progress receipts. Never infer progress from the API
// heartbeat, terminal spinner or elapsed time, and never alter native logs.
export function collectPatrolProgress(
  tasks,
  runner,
  dir,
  previous = {},
  now = Date.now(),
) {
  const result = {};
  for (const task of tasks) {
    const turn = task.turns.find((r) => r.status === 'running');
    if (!turn) continue;
    const folder = path.join(dir, task.id),
      key = task.id + ':' + turn.id;
    const stage = runner?.scheduler?.stages?.running?.find(
      (s) => s.taskId === task.id,
    );
    const startedAt = stage?.startedAt || turn.startedAt;
    let observation;
    if (stage?.kind === 'claude' || turn.stage === 'claude') {
      const container =
        read(path.join(folder, 'container.json')) || task.container;
      if (
        container?.questionId === (turn.questionRootId || turn.id) &&
        container.progress?.lastProgressAt
      )
        observation = {
          ...container.progress,
          source: 'native',
          idleLimitMs: 20 * 60000,
        };
    } else {
      const candidates = list(path.join(folder, 'codex-progress'))
        .filter((f) => f.isFile() && f.name.endsWith('.json'))
        .map((f) => read(path.join(folder, 'codex-progress', f.name)))
        .filter(
          (p) =>
            p?.logicalTurnId?.startsWith(turn.id) &&
            p.stage === (stage?.stage || turn.stage) &&
            Date.parse(p.startedAt) >= Date.parse(startedAt),
        );
      if (turn.stage === 'runtime-running') {
        const walk = (root, depth = 0) => {
          if (depth > 4) return;
          for (const entry of list(root)) {
            const file = path.join(root, entry.name);
            if (entry.isDirectory()) walk(file, depth + 1);
            else if (
              entry.isFile() &&
              entry.name.endsWith('.log.progress.json')
            ) {
              const p = read(file);
              if (p && Date.parse(p.startedAt) >= Date.parse(startedAt))
                candidates.push(p);
            }
          }
        };
        for (const entry of list(folder))
          if (
            entry.isDirectory() &&
            entry.name.startsWith(turn.id + '.attempt-') &&
            entry.name.includes('.runtime-')
          )
            walk(path.join(folder, entry.name));
      }
      observation = candidates
        .sort(
          (a, b) => Date.parse(a.lastProgressAt) - Date.parse(b.lastProgressAt),
        )
        .at(-1);
      if (observation)
        observation = {
          lastProgressAt: observation.lastProgressAt,
          source: 'stage-receipt',
          idleLimitMs: 15 * 60000,
        };
      // Legacy in-flight Codex stages have no receipt. Compare semantic event
      // content over successive observations; stderr growth is not progress.
      if (!observation) {
        const files = list(folder).filter(
          (f) =>
            f.isFile() &&
            f.name.startsWith(turn.id + '.') &&
            f.name.endsWith(
              '.' + (stage?.stage || turn.stage) + '.events.jsonl',
            ),
        );
        const latest = files
          .map((f) => ({
            file: path.join(folder, f.name),
            stat: fs.statSync(path.join(folder, f.name)),
          }))
          .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
          .at(-1);
        let fingerprint = null;
        if (latest) {
          const fd = fs.openSync(latest.file, 'r');
          try {
            const length = Math.min(latest.stat.size, 1024 * 1024),
              buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, latest.stat.size - length);
            const events = buffer
              .toString('utf8')
              .split('\n')
              .flatMap((line) => {
                try {
                  const e = JSON.parse(line);
                  if (!e.item) return [];
                  const { id: _id, ...content } = e.item;
                  return [JSON.stringify([e.type, content])];
                } catch {
                  return [];
                }
              });
            if (events.length)
              fingerprint = createHash('sha256')
                .update([...new Set(events)].join('\n'))
                .digest('hex');
          } finally {
            fs.closeSync(fd);
          }
        }
        const before = previous[key];
        observation = {
          fingerprint,
          source: 'legacy-observation',
          idleLimitMs: 15 * 60000,
          lastProgressAt:
            before?.stageStartedAt === startedAt &&
            before.fingerprint === fingerprint
              ? before.lastProgressAt
              : new Date(now).toISOString(),
        };
      }
    }
    result[key] = {
      ...(observation || {
        source: 'missing-progress',
        lastProgressAt: startedAt,
        idleLimitMs: 20 * 60000,
      }),
      stageStartedAt: startedAt,
      stage: stage?.stage || turn.stage,
    };
  }
  return result;
}
