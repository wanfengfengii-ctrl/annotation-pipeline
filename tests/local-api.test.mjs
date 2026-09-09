import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalApiMonitor,
  probeApi,
  apiHealthUrl,
  acquireApiLock,
  localApiPaths,
} from '../scripts/local-api.mjs';
import {
  localWorkerOptions,
  startLocalWorker,
} from '../scripts/local-api-worker.mjs';

function setup(options = {}) {
  let now = 0,
    healthy = false,
    available = true;
  const children = [],
    records = [];
  const monitor = new LocalApiMonitor({
    now: () => now,
    probe: async () => healthy,
    available: async () => available,
    launch: () => {
      const child = {
        pid: 100 + children.length,
        running: true,
        stops: 0,
        alive() {
          return this.running;
        },
        async stop() {
          this.stops++;
          this.running = false;
        },
      };
      children.push(child);
      return child;
    },
    record: (record) => records.push(record),
    options,
  });
  return {
    monitor,
    children,
    records,
    health: (value) => {
      healthy = value;
    },
    port: (value) => {
      available = value;
    },
    tick: async (time) => {
      now = time;
      return monitor.tick();
    },
  };
}

void test('Healthy API is observed at a fixed localhost URL and its schema is checked', async () => {
  let captured;
  assert.equal(
    await probeApi(async (url, options) => {
      captured = { url, options };
      return Response.json({ config: { enabled: true, concurrency: 3 } });
    }),
    true,
  );
  assert.equal(captured.url, apiHealthUrl);
  assert.equal(captured.options.redirect, 'manual');
  assert.ok(captured.options.signal instanceof AbortSignal);
  for (const request of [
    async () => new Response('error', { status: 503 }),
    async () => Response.json({ token: 'secret-only-in-body' }),
    async () => new Response('not-json'),
    async () => {
      throw Error('secret-only-in-error');
    },
  ])
    assert.equal(await probeApi(request), false);
});

void test('Existing external healthy service is never adopted, restarted or killed', async () => {
  const s = setup();
  s.health(true);
  assert.equal((await s.monitor.start()).phase, 'external');
  s.health(false);
  await s.tick(1000000);
  await s.monitor.close();
  assert.equal(s.children.length, 0);
});

void test('Unknown occupied port blocks startup without touching any process', async () => {
  const s = setup();
  s.port(false);
  assert.equal((await s.monitor.start()).phase, 'blocked');
  await s.tick(1000000);
  await s.monitor.close();
  assert.equal(s.children.length, 0);
});

void test('Healthy owned service never restarts, including after an isolated failed probe', async () => {
  const s = setup();
  await s.monitor.start();
  s.health(true);
  for (const time of [10000, 60000, 120000]) await s.tick(time);
  s.health(false);
  await s.tick(130000);
  assert.equal(s.monitor.state.failures, 1);
  s.health(true);
  await s.tick(140000);
  assert.equal(s.monitor.state.failures, 0);
  assert.equal(s.monitor.state.phase, 'healthy');
  assert.equal(s.children.length, 1);
  assert.equal(s.children[0].stops, 0);
});

void test('Startup grace and three consecutive failures precede a bounded restart', async () => {
  const s = setup();
  await s.monitor.start();
  for (const time of [10000, 20000, 30000, 50000, 59999]) await s.tick(time);
  assert.equal(s.monitor.state.failures, 0);
  for (const time of [60000, 70000]) await s.tick(time);
  assert.equal(s.children[0].stops, 0);
  await s.tick(80000);
  assert.equal(s.children[0].stops, 1);
  assert.equal(s.monitor.state.phase, 'backoff');
  assert.equal(s.monitor.state.nextRetryAt, 90000);
  await s.tick(89999);
  assert.equal(s.children.length, 1);
  await s.tick(90000);
  assert.equal(s.children.length, 2);
  assert.equal(s.monitor.state.phase, 'starting');
});

void test('Repeated failed starts back off exponentially, cap at five minutes and reset only after stable health', async () => {
  const s = setup({ graceMs: 0 });
  await s.monitor.start();
  let time = 0;
  const delays = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    for (let failures = 0; failures < 3; failures++) await s.tick(++time);
    delays.push(s.monitor.state.nextRetryAt - time);
    time = s.monitor.state.nextRetryAt;
    await s.tick(time);
  }
  assert.deepEqual(
    delays,
    [10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000],
  );
  s.health(true);
  await s.tick(++time);
  await s.tick((time += 60000));
  s.health(false);
  for (let failures = 0; failures < 3; failures++) await s.tick(++time);
  assert.equal(s.monitor.state.nextRetryAt - time, 10000);
});

void test('A new external server appearing during backoff is preserved', async () => {
  const s = setup({ graceMs: 0 });
  await s.monitor.start();
  for (const time of [1, 2, 3]) await s.tick(time);
  s.health(true);
  await s.tick(10003);
  assert.equal(s.monitor.state.phase, 'external');
  assert.equal(s.children.length, 1);
  assert.equal(s.children[0].stops, 1);
});

void test('Shutdown only stops the current owned child, once, and prevents later launches', async () => {
  const s = setup({ graceMs: 0 });
  await s.monitor.start();
  for (const time of [1, 2, 3, 10003]) await s.tick(time);
  await Promise.all([s.monitor.close(), s.monitor.close()]);
  await s.tick(1000000);
  await s.monitor.start();
  assert.deepEqual(
    s.children.map((child) => child.stops),
    [1, 1],
  );
  assert.equal(s.monitor.state.phase, 'stopped');
});

void test('A failed termination retains child ownership and prevents duplicate startup', async () => {
  const s = setup({ graceMs: 0 });
  await s.monitor.start();
  s.children[0].stop = async () => {
    throw Error('termination failed');
  };
  for (const time of [1, 2]) await s.tick(time);
  await assert.rejects(s.tick(3), /termination failed/);
  await s.monitor.start();
  assert.equal(s.children.length, 1);
  assert.equal(s.monitor.child, s.children[0]);
});

void test('A signal arriving during a pending startup probe cannot create a child afterward', async () => {
  let resolve,
    launches = 0;
  const monitor = new LocalApiMonitor({
    probe: () =>
      new Promise((done) => {
        resolve = done;
      }),
    available: async () => true,
    launch: () => {
      launches++;
      throw Error('must not launch');
    },
  });
  const starting = monitor.start();
  await monitor.close();
  resolve(false);
  await starting;
  assert.equal(launches, 0);
  assert.equal(monitor.state.phase, 'stopped');
});

void test('Lock excludes a living owner, replaces a dead owner and only releases its own token', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'local-api-lock-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const filename = path.join(temp, 'api.lock');
  const unlock = acquireApiLock(filename, { pid: 7, alive: () => true });
  assert.throws(
    () => acquireApiLock(filename, { pid: 8, alive: () => true }),
    /API_LOCK_ACTIVE/,
  );
  unlock();
  assert.equal(existsSync(filename), false);
  writeFileSync(filename, JSON.stringify({ pid: 99999999, owner: 'dead' }));
  const release = acquireApiLock(filename, { pid: 9, alive: () => false });
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).pid, 9);
  writeFileSync(filename, JSON.stringify({ pid: 10, owner: 'new' }));
  release();
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).pid, 10);
});

void test('Immutable API release is separate from explicitly required, existing database root', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'local-api-path-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'new-release'),
    api = path.join(temp, 'old-api');
  mkdirSync(path.join(api, 'dist/server'), { recursive: true });
  writeFileSync(path.join(api, 'dist/server/wrangler.json'), '{}');
  mkdirSync(path.join(temp, '.wrangler/state'), { recursive: true });
  const result = localApiPaths(source, temp, api);
  assert.equal(result.config, path.join(api, 'dist/server/wrangler.json'));
  assert.equal(result.persist, path.join(temp, '.wrangler/state'));
  assert.equal(result.stateRoot, path.join(temp, '.runner'));
  assert.throws(() => localApiPaths(source), /API_WORK_ROOT_REQUIRED/);
  assert.throws(
    () => localApiPaths(source, 'relative', api),
    /API_WORK_ROOT_REQUIRED/,
  );
  assert.throws(
    () => localApiPaths(source, temp, 'relative'),
    /API_RELEASE_DIR_INVALID/,
  );
  assert.throws(() => localApiPaths(source, source, api), /API_PATHS_MISSING/);
});

void test('Worker disables inspector, file watching, live reload and remote execution while retaining the original database', () => {
  const config = '/verified-release/dist/server/wrangler.json';
  const persist = '/original-repo/.wrangler/state';
  assert.deepEqual(localWorkerOptions(config, persist), {
    config,
    dev: {
      inspector: false,
      watch: false,
      liveReload: false,
      remote: false,
      persist,
      server: { hostname: '127.0.0.1', port: 3000 },
      logLevel: 'warn',
    },
  });
  assert.throws(
    () => localWorkerOptions('relative', persist),
    /API_WORKER_PATHS_INVALID/,
  );
});

void test('Worker awaits readiness and rejects an unexpectedly enabled inspector with disposal', async () => {
  let options,
    disposed = 0;
  const worker = {
    ready: Promise.resolve(),
    inspectorUrl: Promise.resolve(undefined),
    dispose: async () => {
      disposed++;
    },
  };
  assert.equal(
    await startLocalWorker('/config', '/persist', async (input) => {
      options = input;
      return worker;
    }),
    worker,
  );
  assert.equal(options.dev.inspector, false);
  assert.equal(disposed, 0);
  worker.inspectorUrl = Promise.resolve(new URL('http://127.0.0.1:9229'));
  await assert.rejects(
    startLocalWorker('/config', '/persist', async () => worker),
    /API_INSPECTOR_ENABLED/,
  );
  assert.equal(disposed, 1);
});
