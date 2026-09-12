import fs from 'node:fs';
import path from 'node:path';
import { publishJobRelease } from './publish-job-release.mjs';
import { verifyJobRelease } from './job-release.mjs';
import { identity } from './recovery.mjs';
import {
  readJSON,
  saveJSON,
  command,
  launch,
  exactProcess,
  localAPI,
} from './self-heal-io.mjs';
import { runCheck } from './self-heal-repair.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export function runnerHasWork(data) {
  const s = data?.runner?.scheduler;
  return (
    !s ||
    !Number.isFinite(s.active) ||
    s.active > 0 ||
    s.recovering > 0 ||
    s.generating ||
    s.finalizing > 0 ||
    s.stages?.running?.length > 0 ||
    data.tasks?.some((t) => t.turns?.some((r) => r.status === 'running'))
  );
}
export async function adoptIdleRunner(root) {
  const work = path.join(root, '.runner'),
    file = path.join(work, 'self-heal/runner-adoption.json'),
    pending = readJSON(file);
  if (!pending || pending.completedAt) return;
  const current = verifyJobRelease(
    readJSON(path.join(work, 'job-release-current.json')),
    work,
  );
  const pid = readJSON(path.join(work, 'runner.lock'));
  if (!pid || !identity(pid)) return; // ensureServices starts the latest release.
  if (exactProcess(pid, current.root, 'scripts/runner.mjs')) {
    saveJSON(file, { ...pending, completedAt: new Date().toISOString() });
    return;
  }
  if (pending.signaledIdentity === identity(pid)) return;
  const data = await localAPI('/api/tasks');
  if (runnerHasWork(data) || data.runner?.scheduler?.draining) return;
  if (!exactProcess(pid, pending.oldRoot, 'scripts/runner.mjs'))
    throw Error('待更新执行器归属不一致');
  saveJSON(file, {
    ...pending,
    signaledIdentity: identity(pid),
    signaledAt: new Date().toISOString(),
  });
  process.kill(pid, 'SIGUSR2');
}
export function prepareBuildDependencies(releaseRoot, sourceRoot) {
  if (path.dirname(releaseRoot) !== path.join(sourceRoot, '.runner/releases'))
    throw Error('只允许准备独立候选版本');
  const target = path.join(releaseRoot, 'node_modules'),
    source = path.join(sourceRoot, 'node_modules');
  if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (name.startsWith('.vite')) continue;
    const link = path.join(target, name);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(source, name), link);
  }
}
async function stopApi(root, state) {
  if (!identity(state.supervisorPid)) return;
  if (
    !exactProcess(
      state.supervisorPid,
      state.releaseRoot,
      'scripts/local-api.mjs',
    )
  )
    throw Error('API 进程归属不一致');
  const before = identity(state.supervisorPid);
  process.kill(state.supervisorPid, 'SIGTERM');
  for (let n = 0; n < 40 && identity(state.supervisorPid) === before; n++)
    await pause(500);
  if (identity(state.supervisorPid)) throw Error('API 尚未自然退出');
}
async function waitApi(release, pid, root) {
  for (let n = 0; n < 40; n++) {
    if (!identity(pid)) return false;
    const s = readJSON(path.join(root, '.runner/local-api.json'));
    if (
      s?.supervisorPid === pid &&
      s.releaseRoot === release &&
      s.phase === 'healthy'
    ) {
      try {
        await localAPI('/api/scheduler');
        return true;
      } catch {}
    }
    await pause(1000);
  }
  return false;
}

// Each phase is journaled. Draining is cooperative and never has a kill deadline.
export async function advanceRelease(root, job, jobFile) {
  const work = path.join(root, '.runner'),
    file = path.join(work, 'self-heal/deploy.json');
  let state = readJSON(file);
  if (state?.active && state.jobId !== job.id) return { waiting: true };
  if (!state || state.jobId !== job.id) {
    state = {
      active: true,
      jobId: job.id,
      commit: job.commit,
      phase: 'prepare',
      oldPointer: readJSON(path.join(work, 'job-release-current.json')),
      oldApi: readJSON(path.join(work, 'local-api.json')),
    };
    saveJSON(file, state);
  }
  const save = (patch) => {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    saveJSON(file, state);
  };
  try {
    if (state.phase === 'prepare') {
      const release = publishJobRelease({
        sourceRoot: root,
        workRoot: work,
        commit: job.commit,
        activate: false,
      });
      save({ release, phase: 'build' });
    }
    if (state.phase === 'build') {
      const release = state.release.root;
      prepareBuildDependencies(release, root);
      // Build runs against a frozen candidate before changing live pointers.
      const cli = path.join(root, 'node_modules/vinext/dist/cli.js');
      if (!fs.existsSync(cli)) throw Error('无法定位已安装的构建入口');
      if (
        (await runCheck(
          release,
          [cli, 'build'],
          path.join(work, 'self-heal/jobs', job.id, 'build.log'),
        )) !== 0
      )
        throw Error('冻结版本构建未通过');
      verifyJobRelease(state.release, work);
      save({ phase: 'activate' });
    }
    if (state.phase === 'activate') {
      const head = command('git', ['rev-parse', 'HEAD'], root);
      if (head !== job.commit) {
        if (
          head !== job.baseCommit ||
          command('git', ['status', '--porcelain'], root)
        )
          throw Error('发布时主工作区已变化');
        command('git', ['merge', '--ff-only', job.commit], root);
      }
      // Changing only future jobs is immediate; the main scheduler adopts the
      // same version after its current work drains naturally.
      const currentApi = readJSON(path.join(work, 'local-api.json'));
      if (currentApi.releaseRoot !== state.release.root) {
        save({ phase: 'api-switch' });
      } else save({ phase: 'jobs' });
    }
    if (state.phase === 'api-switch') {
      const current = readJSON(path.join(work, 'local-api.json'));
      if (
        current.releaseRoot !== state.release.root ||
        !identity(current.supervisorPid)
      ) {
        if (identity(current.supervisorPid)) await stopApi(root, current);
        const child = launch(
          state.release.root,
          'scripts/local-api.mjs',
          { API_WORK_ROOT: root, API_RELEASE_DIR: state.release.root },
          path.join(work, 'self-heal/api.log'),
        );
        save({ apiPid: child.pid });
        if (!(await waitApi(state.release.root, child.pid, root))) {
          const failed = readJSON(path.join(work, 'local-api.json'));
          if (failed?.supervisorPid === child.pid) await stopApi(root, failed);
          const old = state.oldApi;
          const restored = launch(
            old.releaseRoot,
            'scripts/local-api.mjs',
            { API_WORK_ROOT: root, API_RELEASE_DIR: old.releaseRoot },
            path.join(work, 'self-heal/api.log'),
          );
          save({
            rollbackPid: restored.pid,
            rollbackHealthy: await waitApi(old.releaseRoot, restored.pid, root),
          });
          throw Error('新 API 健康检查失败，已执行旧版本恢复');
        }
      }
      save({ phase: 'jobs' });
    }
    if (state.phase === 'jobs') {
      publishJobRelease({
        sourceRoot: root,
        workRoot: work,
        commit: job.commit,
      });
      save({ phase: 'drain' });
    }
    if (state.phase === 'drain') {
      const pid = readJSON(path.join(work, 'runner.lock'));
      if (pid && identity(pid)) {
        const data = await localAPI('/api/tasks'),
          { runner } = data;
        if (runnerHasWork(data) && !runner?.scheduler?.draining) {
          // Future claims already load the verified release. Do not stop all
          // admissions behind one stuck old observer just to refresh the scheduler.
          saveJSON(path.join(work, 'self-heal/runner-adoption.json'), {
            jobId: job.id,
            oldRoot: state.oldPointer.root,
            requestedAt: new Date().toISOString(),
          });
          job.runnerAdoption = 'waiting-idle';
          saveJSON(jobFile, job);
          save({ phase: 'push' });
        } else {
          save({ oldRunnerPid: pid, oldRunnerIdentity: identity(pid) });
          if (!runner?.scheduler?.draining) {
            const oldRoot = state.oldPointer.root;
            if (
              !exactProcess(pid, oldRoot, 'scripts/runner.mjs') &&
              !exactProcess(pid, root, 'scripts/runner.mjs')
            )
              throw Error('执行器归属不一致，保留现场');
            // Persist identity before the signal so a restarted controller won't
            // mistake a reused PID for the old runner.
            save({ oldRunnerPid: pid, oldRunnerIdentity: identity(pid) });
            process.kill(pid, 'SIGUSR2');
          }
          save({ phase: 'waiting-runner' });
          return { waiting: true };
        }
      } else save({ phase: 'start-runner' });
    }
    if (state.phase === 'waiting-runner') {
      if (
        state.oldRunnerPid &&
        identity(state.oldRunnerPid) === state.oldRunnerIdentity
      )
        return { waiting: true };
      const pid = readJSON(path.join(work, 'runner.lock'));
      if (pid && identity(pid)) {
        if (!exactProcess(pid, state.release.root, 'scripts/runner.mjs'))
          throw Error('其他执行器正在接管，保留发布记录');
        save({ newRunnerPid: pid, phase: 'verify-runner' });
      } else save({ phase: 'start-runner' });
    }
    if (state.phase === 'start-runner') {
      const { config } = await localAPI('/api/scheduler');
      if (!config.enabled) return { waiting: true };
      const p = launch(
        state.release.root,
        'scripts/runner.mjs',
        { RUNNER_WORK_ROOT: work },
        path.join(work, 'self-heal/runner.log'),
      );
      save({ newRunnerPid: p.pid, phase: 'verify-runner' });
      return { waiting: true };
    }
    if (state.phase === 'verify-runner') {
      if (
        !exactProcess(
          state.newRunnerPid,
          state.release.root,
          'scripts/runner.mjs',
        )
      )
        throw Error('新执行器未存活');
      const { runner } = await localAPI('/api/tasks');
      if (
        !runner?.scheduler ||
        runner.scheduler.draining ||
        Date.now() - Date.parse(runner.heartbeat) > 30000
      )
        return { waiting: true };
      save({ phase: 'push' });
    }
    if (state.phase === 'push') {
      if (state.pushRetryAt && Date.now() < Date.parse(state.pushRetryAt))
        return { waiting: true };
      try {
        command('git', ['push', 'origin', 'HEAD:main'], root);
      } catch (e) {
        save({
          pushError: e.message,
          pushRetryAt: new Date(Date.now() + 5 * 60000).toISOString(),
        });
        return { waiting: true };
      }
      save({
        active: false,
        phase: 'complete',
        completedAt: new Date().toISOString(),
      });
      Object.assign(job, {
        state: 'published',
        phase: 'published',
        release: state.release,
        finishedAt: new Date().toISOString(),
      });
      saveJSON(jobFile, job);
    }
    return { complete: state.phase === 'complete' };
  } catch (e) {
    save({ active: false, phase: 'failed', reason: e.message });
    throw e;
  }
}
