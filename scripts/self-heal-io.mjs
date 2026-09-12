import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { collectPatrolProgress } from './patrol-progress.mjs';
import { patrolHealth } from '../lib/patrol-health.mjs';
import { identity } from './recovery.mjs';
import { verifyJobRelease } from './job-release.mjs';
import { createHash } from 'node:crypto';

export const readJSON = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
};
export function saveJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export async function localAPI(route, options = {}) {
  const response = await fetch('http://127.0.0.1:3000' + route, {
    ...options,
    headers: { ...options.headers, 'content-type': 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      '本地接口 ' +
        response.status +
        ': ' +
        (await response.text()).slice(0, 1000),
    );
  return response.json();
}
export async function observe(root, previous = {}) {
  const [data, scheduler] = await Promise.all([
    localAPI('/api/operations/source').catch((e) => {
      if (e.message.startsWith('本地接口 404:')) return localAPI('/api/tasks');
      throw e;
    }),
    localAPI('/api/scheduler'),
  ]);
  const progress = collectPatrolProgress(
    data.tasks,
    data.runner,
    path.join(root, '.runner'),
    previous.progress,
  );
  const health = patrolHealth({
    ...data,
    config: scheduler.config,
    previous,
    progress,
  });
  const external = readJSON(
    path.join(root, '.runner/self-heal/external-events.json'),
    {},
  );
  const finalizations = readJSON(
    path.join(root, '.runner/finalization-queue.json'),
    {},
  );
  for (const [taskId, failure] of Object.entries(finalizations)) {
    const task = data.tasks.find((t) => t.id === taskId);
    if (
      !task ||
      !failure.plan?.turnId ||
      task.container?.questionId !== failure.plan.questionId ||
      task.container?.containerId !== failure.plan.containerId
    )
      continue;
    health.incidents.push({
      id: taskId + ':' + failure.plan.turnId,
      taskId,
      turnId: failure.plan.turnId,
      stage: 'finalization',
      state: 'open',
      reason: failure.reason,
      evidenceKey: failure.conditionsKey,
    });
    health.needsAction = true;
  }
  const uploads = Object.keys(external).length
    ? readJSON(path.join(root, '.runner/solo-upload/ui-state.json'), {
        entries: {},
      }).entries
    : {};
  health.externalResolvedIds = [];
  for (const [key, event] of Object.entries(external)) {
    if (event.source !== 'solo-upload' || !Array.isArray(event.keys)) continue;
    if (
      event.keys.length &&
      event.keys.every(
        (k) => uploads[k]?.remoteId && uploads[k].receiptVerified === true,
      )
    )
      health.externalResolvedIds.push(key);
    else {
      health.incidents.push({
        id: 'external:' + key,
        externalKey: key,
        stage: 'upload',
        state: 'open',
        reason: event.reason,
      });
      health.needsAction = true;
    }
  }
  return {
    ...data,
    config: scheduler.config,
    health,
    recoveryRevision: readJSON(
      path.join(root, '.runner/job-release-current.json'),
    )?.manifestSha256,
  };
}
export async function guardedRetry(root, incident, action) {
  const { recoveryAction } = await import('../lib/self-heal.mjs');
  const { tasks } = await localAPI('/api/tasks');
  const task = tasks.find((t) => t.id === incident.taskId),
    turn = task?.turns.find((t) => t.id === incident.turnId);
  if (recoveryAction(task, turn) !== action)
    return {
      state: 'not_eligible',
      reason: '状态已改变，由既有执行器继续处理',
    };
  await localAPI('/api/tasks/' + task.id, {
    method: 'PATCH',
    body: JSON.stringify({ action, turnId: turn.id, revision: task.revision }),
  });
  return { state: 'queued', action, at: new Date().toISOString() };
}
export function command(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function launch(root, script, env, log) {
  const fd = fs.openSync(log, 'a', 0o600);
  const p = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  p.on('error', () => {});
  p.unref();
  if (!p.pid) throw Error('后台进程未启动');
  return { pid: p.pid, identity: identity(p.pid) };
}
export function exactProcess(pid, expectedRoot, script) {
  if (!Number.isInteger(pid) || !identity(pid)) return false;
  try {
    const cmd = command(
      'ps',
      ['-p', String(pid), '-o', 'command='],
      expectedRoot,
    );
    const cwd = command(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      expectedRoot,
    )
      .split('\n')
      .find((l) => l.startsWith('n'))
      ?.slice(1);
    return cwd === expectedRoot && cmd.includes(script);
  } catch {
    return false;
  }
}

// The job pointer selects future jobs; it is not the running scheduler's cwd.
export function ownedRunnerRoot(root, pid) {
  const before = identity(pid);
  if (!Number.isInteger(pid) || !before) throw Error('执行器进程已变化');
  const cwd = command(
    'lsof',
    ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    root,
  )
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  if (!cwd || !exactProcess(pid, cwd, 'scripts/runner.mjs'))
    throw Error('执行器归属不一致');
  if (cwd !== root) {
    if (path.dirname(cwd) !== path.join(root, '.runner/releases'))
      throw Error('执行器不属于本项目');
    const manifest = fs.readFileSync(path.join(cwd, 'job-release.json'));
    verifyJobRelease(
      {
        root: cwd,
        manifestSha256: createHash('sha256').update(manifest).digest('hex'),
      },
      path.join(root, '.runner'),
    );
  }
  if (identity(pid) !== before) throw Error('执行器进程已变化');
  return cwd;
}

// Restart only absent owned services; a live but slow runner is diagnosed, not killed.
export async function ensureServices(root, { enabled = false } = {}) {
  const work = path.join(root, '.runner'),
    result = [];
  if (readJSON(path.join(work, 'self-heal/deploy.json'))?.active) return result;
  const api = readJSON(path.join(work, 'local-api.json'));
  if (api && !identity(api.supervisorPid)) {
    const lock = readJSON(path.join(work, 'local-api.lock'));
    if (!lock || !identity(typeof lock === 'number' ? lock : lock.pid)) {
      result.push({
        service: 'api',
        ...launch(
          api.releaseRoot,
          'scripts/local-api.mjs',
          { API_WORK_ROOT: root, API_RELEASE_DIR: api.releaseRoot },
          path.join(work, 'self-heal/api.log'),
        ),
      });
    }
  }
  const pid = readJSON(path.join(work, 'runner.lock'));
  if (enabled && (!pid || !identity(pid))) {
    const { verifyJobRelease } = await import('./job-release.mjs');
    const release = verifyJobRelease(
      readJSON(path.join(work, 'job-release-current.json')),
      work,
    );
    result.push({
      service: 'runner',
      ...launch(
        release.root,
        'scripts/runner.mjs',
        { RUNNER_WORK_ROOT: work },
        path.join(work, 'self-heal/runner.log'),
      ),
    });
  }
  return result;
}
