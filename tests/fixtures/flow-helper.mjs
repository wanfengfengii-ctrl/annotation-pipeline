import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import path from 'node:path';
import { base } from './test-server.mjs';
export { base };
const root = process.cwd();
export async function api(route, body, method = 'POST') {
  const r = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
export function fixture(name, extra = {}) {
  const dir = path.join(root, '.runner', name + '-' + Date.now()),
    bin = path.join(dir, 'bin'),
    runtime = path.join(dir, 'runtime');
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtime);
  for (const name of ['git', 'gh', 'codex', 'docker', 'claude']) {
    const file = path.join(bin, name);
    copyFileSync('tests/fixtures/pipeline-cli.cjs', file);
    chmodSync(file, 0o755);
  }
  writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  const log = path.join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  return { dir, bin, runtime, log, extra };
}
export function start(f) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      path.join(root, 'tests/fixtures/docker-flow-preload.mjs'),
      'scripts/runner.mjs',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: f.bin + path.delimiter + process.env.PATH,
        PIPELINE_API_URL: base,
        RUNNER_WORK_ROOT: f.runtime,
        FIXTURE_BIN: f.bin,
        FIXTURE_LOG: f.log,
        ...f.extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  f.errors = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => (f.errors += d));
  return child;
}
export async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('runner did not stop'));
    }, 8000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
export async function waitTask(id, predicate, timeout = 120000) {
  const end = Date.now() + timeout;
  let task;
  while (Date.now() < end) {
    task = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === id,
    );
    if (task && predicate(task)) return task;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error(
    'Timeout: ' +
      JSON.stringify(
        task?.turns.map((r) => ({
          status: r.status,
          error: r.error,
          stage: r.stage,
        })),
      ),
  );
}
export async function create(f, title, projectSeries = true) {
  return (
    await api('/api/tasks', {
      title,
      repoPath: f.bin,
      stack: 'fixture',
      category: projectSeries ? '0-1 代码生成' : '代码测试',
      difficulty: '中等',
      reproducibility: '无外部依赖',
      projectSeries,
      autoStart: true,
    })
  ).task;
}
export function calls(f) {
  return readFileSync(f.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}
