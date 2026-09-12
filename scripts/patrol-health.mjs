import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPatrolProgress } from './patrol-progress.mjs';
import { patrolHealth } from '../lib/patrol-health.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.runner');
const file = path.join(dir, 'patrol-health.json');
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
const get = async (route) => {
  const r = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Error('巡检接口失败：' + route + ' HTTP ' + r.status);
  return r.json();
};
try {
  const [data, scheduler] = await Promise.all([
    get('/api/tasks'),
    get('/api/scheduler'),
  ]);
  const previous = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
  const progress = collectPatrolProgress(
    data.tasks,
    data.runner,
    dir,
    previous.progress,
  );
  const health = patrolHealth({
    ...data,
    config: scheduler.config,
    previous,
    progress,
  });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(health, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  console.log(JSON.stringify(health, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'observation_failed',
      needsAction: true,
      reason: error.message,
    }),
  );
  process.exitCode = 1;
}
