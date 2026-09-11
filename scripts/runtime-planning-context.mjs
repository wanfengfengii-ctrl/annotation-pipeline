import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evidencePath } from './evidence.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function runtimePlanningContext({ task, turn, dir, files }) {
  const index = task.turns.findIndex((r) => r.id === turn.id);
  const previous = task.turns
    .slice(0, Math.max(0, index))
    .filter((r) => !r.excluded && r.automation?.archive?.manifestSha256)
    .at(-1);
  let prior = null;
  if (previous) {
    try {
      const archive = previous.automation.archive;
      const bytes = readFileSync(evidencePath(archive.manifestPath, dir));
      if (hash(bytes) !== archive.manifestSha256)
        throw Error('历史源码清单摘要不符');
      prior = new Map(
        JSON.parse(bytes)
          .files.filter((f) => f.name.startsWith('workspace/'))
          .map((f) => [f.name.slice(10), f.sha256]),
      );
    } catch {
      /* No verified baseline means a full current-source plan. */
    }
  }
  const current = new Map(files.map((f) => [f.path, f.sha256]));
  const changed = prior
    ? files.filter((f) => prior.get(f.path) !== f.sha256).map((f) => f.path)
    : null;
  const removed = prior ? [...prior.keys()].filter((f) => !current.has(f)) : [];
  return {
    version: '2026-09-11.runtime-navigation1',
    previousTurnId: prior ? previous.id : null,
    inventorySha256: hash(JSON.stringify(files)),
    files: files.map((f) => f.path),
    changed,
    removed,
    entryCandidates: files
      .filter((f) =>
        /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|README[^/]*|app\.[^/]+|server\.[^/]+|main\.[^/]+|index\.html)$/.test(
          f.path,
        ),
      )
      .map((f) => f.path),
    note: '文件差异只用于定位；未改动的关联代码仍须检查，历史通过不能代替本题独立运行。',
  };
}
