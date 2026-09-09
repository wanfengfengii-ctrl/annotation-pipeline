import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const apiHealthUrl = 'http://127.0.0.1:3000/api/scheduler';
export const monitorDefaults = Object.freeze({
  intervalMs: 10000,
  timeoutMs: 3000,
  graceMs: 60000,
  failureThreshold: 3,
  backoffMs: 10000,
  maxBackoffMs: 300000,
  stableMs: 60000,
});

// Only returns a boolean; HTTP bodies and exceptions may contain private data.
export async function probeApi(
  request = fetch,
  timeoutMs = monitorDefaults.timeoutMs,
) {
  try {
    const response = await request(apiHealthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    if (!response.ok) return false;
    const data = await response.json();
    return (
      typeof data?.config?.enabled === 'boolean' &&
      Number.isInteger(data.config.concurrency)
    );
  } catch {
    return false;
  }
}

export function portAvailable() {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: 3000, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// Operations are serial: the executable awaits each tick before scheduling the
// next. Child handles are only supplied by launch(), never discovered by PID.
export class LocalApiMonitor {
  constructor({
    probe,
    available,
    launch,
    now = Date.now,
    record = () => {},
    options = {},
  }) {
    this.io = { probe, available, launch, now, record };
    this.options = { ...monitorDefaults, ...options };
    this.child = null;
    this.closed = false;
    this.stableSince = null;
    this.backoffLevel = 0;
    this.state = {
      phase: 'idle',
      failures: 0,
      restarts: 0,
      childPid: null,
      nextRetryAt: null,
    };
  }

  report(patch = {}) {
    Object.assign(this.state, patch, { checkedAt: this.io.now() });
    this.io.record({ ...this.state });
    return { ...this.state };
  }

  async start() {
    if (this.closed || this.child) return this.state;
    const healthy = await this.io.probe();
    if (this.closed) return this.state;
    if (healthy) return this.report({ phase: 'external', childPid: null });
    const available = await this.io.available();
    if (this.closed) return this.state;
    if (!available) return this.report({ phase: 'blocked', childPid: null });
    try {
      this.child = this.io.launch();
      this.startedAt = this.io.now();
      this.stableSince = null;
      return this.report({
        phase: 'starting',
        childPid: this.child.pid,
        failures: 0,
        nextRetryAt: null,
      });
    } catch {
      return this.deferRestart();
    }
  }

  deferRestart() {
    const delay = Math.min(
      this.options.maxBackoffMs,
      this.options.backoffMs * 2 ** Math.min(this.backoffLevel++, 16),
    );
    return this.report({
      phase: 'backoff',
      childPid: null,
      failures: 0,
      restarts: this.state.restarts + 1,
      nextRetryAt: this.io.now() + delay,
    });
  }

  async stopOwned() {
    const child = this.child;
    if (!child) return;
    await child.stop();
    // Retain ownership if termination fails: never launch a duplicate child.
    if (this.child === child) this.child = null;
  }

  async tick() {
    if (
      this.closed ||
      ['external', 'blocked', 'stopped'].includes(this.state.phase)
    )
      return this.state;
    if (!this.child) {
      if (this.io.now() >= (this.state.nextRetryAt ?? 0)) return this.start();
      return this.report();
    }
    const healthy = await this.io.probe();
    if (this.closed) return this.state;
    const now = this.io.now();
    if (healthy && this.child.alive()) {
      this.stableSince ??= now;
      if (now - this.stableSince >= this.options.stableMs)
        this.backoffLevel = 0;
      return this.report({ phase: 'healthy', failures: 0, lastHealthyAt: now });
    }
    this.stableSince = null;
    if (now - this.startedAt < this.options.graceMs)
      return this.report({ phase: 'starting', failures: 0 });
    this.report({ phase: 'unhealthy', failures: this.state.failures + 1 });
    if (this.state.failures < this.options.failureThreshold) return this.state;
    await this.stopOwned();
    if (this.closed) return this.state;
    return this.deferRestart();
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await this.stopOwned();
      return this.report({
        phase: 'stopped',
        childPid: null,
        nextRetryAt: null,
      });
    })();
    return this.closing;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export function acquireApiLock(
  filename,
  { pid = process.pid, alive = pidAlive } = {},
) {
  const payload = JSON.stringify({ pid, owner: randomUUID() });
  try {
    writeFileSync(filename, payload, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readFileSync(filename, 'utf8');
    let owner;
    try {
      owner = JSON.parse(previous);
    } catch {
      throw Error('API_LOCK_INVALID');
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid))
      throw Error('API_LOCK_ACTIVE');
    if (readFileSync(filename, 'utf8') !== previous)
      throw Error('API_LOCK_CHANGED');
    unlinkSync(filename);
    writeFileSync(filename, payload, { flag: 'wx', mode: 0o600 });
  }
  return () => {
    try {
      if (readFileSync(filename, 'utf8') === payload) unlinkSync(filename);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

export function localApiPaths(
  releaseRoot,
  workRoot,
  apiReleaseRoot = releaseRoot,
) {
  if (!workRoot || !path.isAbsolute(workRoot))
    throw Error('API_WORK_ROOT_REQUIRED');
  if (!path.isAbsolute(apiReleaseRoot)) throw Error('API_RELEASE_DIR_INVALID');
  const config = path.join(apiReleaseRoot, 'dist/server/wrangler.json');
  const persist = path.join(workRoot, '.wrangler/state');
  // A wrong directory must never silently create an empty production database.
  if (!existsSync(config) || !existsSync(persist))
    throw Error('API_PATHS_MISSING');
  return {
    config,
    persist,
    releaseRoot: apiReleaseRoot,
    stateRoot: path.join(workRoot, '.runner'),
  };
}

// The detached group is created here and never adopted from another process.
// Wrangler stdout/stderr are deliberately suppressed: the supervisor logs only
// its own status vocabulary, not environment values or raw child diagnostics.
export function launchWrangler({ config, persist }, releaseRoot) {
  const workerScript = fileURLToPath(
    new URL('./local-api-worker.mjs', import.meta.url),
  );
  const child = spawn(process.execPath, [workerScript, config, persist], {
    cwd: releaseRoot,
    detached: true,
    stdio: 'ignore',
  });
  let exited = false,
    stopping;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });
  const groupAlive = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };
  const signal = (name) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  return {
    pid: child.pid ?? null,
    alive: () => !exited && child.pid != null,
    stop: () =>
      (stopping ??= (async () => {
        signal('SIGTERM');
        for (let i = 0; i < 40 && groupAlive(); i++) await sleep(100);
        if (groupAlive()) signal('SIGKILL');
        for (let i = 0; i < 20 && groupAlive(); i++) await sleep(100);
        if (groupAlive()) throw Error('API_CHILD_STOP_FAILED');
      })()),
  };
}

export async function main() {
  const releaseRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const paths = localApiPaths(
    releaseRoot,
    process.env.API_WORK_ROOT,
    process.env.API_RELEASE_DIR,
  );
  mkdirSync(paths.stateRoot, { recursive: true });
  const unlock = acquireApiLock(path.join(paths.stateRoot, 'local-api.lock'));
  const stateFile = path.join(paths.stateRoot, 'local-api.json');
  let lastPhase;
  const monitor = new LocalApiMonitor({
    probe: probeApi,
    available: portAvailable,
    launch: () => launchWrangler(paths, paths.releaseRoot),
    record: (state) => {
      const safe = { version: 1, supervisorPid: process.pid, ...state };
      const temp = `${stateFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(safe, null, 2), { mode: 0o600 });
      renameSync(temp, stateFile);
      if (state.phase !== lastPhase) {
        console.log(
          `[local-api] ${state.phase} failures=${state.failures} restarts=${state.restarts}`,
        );
        lastPhase = state.phase;
      }
    },
  });
  const controller = new AbortController();
  const onSignal = () => {
    controller.abort();
    void monitor.close().catch(() => {});
  };
  for (const name of ['SIGINT', 'SIGTERM']) process.on(name, onSignal);
  try {
    await monitor.start();
    while (
      !controller.signal.aborted &&
      !['external', 'blocked'].includes(monitor.state.phase)
    ) {
      try {
        await sleep(monitorDefaults.intervalMs, undefined, {
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
      if (!controller.signal.aborted) await monitor.tick();
    }
    if (monitor.state.phase === 'blocked') process.exitCode = 1;
  } finally {
    // Keep external/blocked evidence in the state file; neither has an owned child.
    if (!['external', 'blocked'].includes(monitor.state.phase))
      await monitor.close();
    unlock();
    for (const name of ['SIGINT', 'SIGTERM']) process.off(name, onSignal);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      '[local-api] failed; check local-api.json and local-api.lock',
    );
    process.exitCode = 1;
  });
}
