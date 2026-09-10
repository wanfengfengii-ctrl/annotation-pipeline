import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  utimesSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { StageBudget } from '../scripts/stage-budget.mjs';
import { attemptTiming, summarizeTiming } from '../scripts/attempt-timing.mjs';
import { sessionFinalization } from '../lib/session-finalization.mjs';
import { FinalizationQueue } from '../scripts/finalization-queue.mjs';
import { terminalProtocolVersion } from '../scripts/mac-terminal.mjs';
import { ProviderHealth } from '../scripts/provider-health.mjs';
import {
  canReplenish,
  supplyDecision,
  heavyMemoryBudget,
  projectCapacityWithVerifier,
} from '../scripts/scheduler.mjs';
import { resourceProfile } from '../lib/container-policy.mjs';
import { PilotGate } from '../scripts/pilot-gate.mjs';
import { SourceHashCache } from '../scripts/source-hash-cache.mjs';
import {
  verifyJobRelease,
  loadJobRelease,
  jobReleaseProtocol,
} from '../scripts/job-release.mjs';
import { NativeProgressWatch } from '../scripts/native-progress.mjs';
import { validateReadiness } from '../scripts/environment-readiness.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function temp(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'throughput-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('shared budget overlaps Claude with postprocessing, limits Codex/heavy and prioritizes delivery', async () => {
  const budget = new StageBudget({ capacity: 3 }),
    a = deferred(),
    b = deferred(),
    order = [];
  const first = budget.run('claude', 'a', 'claude', () => a.promise);
  const scoring = budget.run('codex', 'b', 'score', () => b.promise);
  const generating = budget.run('codex', 'supply', 'generate', async () =>
    order.push('generate'),
  );
  const delivery = budget.run('codex', 'c', 'delivery', async () =>
    order.push('delivery'),
  );
  const heavy = budget.run('heavy', 'c', 'runtime-running', async () =>
    order.push('heavy'),
  );
  await heavy;
  assert.equal(budget.running.size, 2);
  b.resolve();
  await scoring;
  await delivery;
  await generating;
  assert.deepEqual(order, ['heavy', 'delivery', 'generate']);
  a.resolve();
  await first;
});
test('capacity shrink does not stop active work; waiting resumes after load recovery', async () => {
  const b = new StageBudget({ capacity: 2 }),
    gate = deferred();
  let ran = false;
  const live = b.run('claude', 'a', 'claude', () => gate.promise);
  await tick();
  b.update(0);
  const waiting = b.run('heavy', 'b', 'runtime-running', async () => {
    ran = true;
  });
  gate.resolve();
  await live;
  await tick();
  assert.equal(ran, false);
  b.update(1);
  await waiting;
  assert.equal(ran, true);
});
test('stage errors release leases and stop cancels queued work', async () => {
  let stopped = false;
  const b = new StageBudget({ capacity: 1, stopped: () => stopped });
  await assert.rejects(
    b.run('codex', 'a', 'score', async () => {
      throw Error('failure');
    }),
  );
  assert.equal(b.running.size, 0);
  b.update(0);
  const pending = b.run('codex', 'a', 'prepare', async () => {});
  stopped = true;
  b.update(1);
  await assert.rejects(pending, /停止/);
});
test('existing-container environment preparation runs without reserving a new verifier container', async () => {
  const b = new StageBudget({ capacity: 3 });
  b.update(3, { heavyAllowed: false });
  let verified = false;
  const waiting = b.run('heavy', 'verify', 'runtime-running', async () => {
    verified = true;
  });
  await b.run('heavy', 'prepare', 'environment-ready', async () => {});
  assert.equal(verified, false);
  b.update(3, { heavyAllowed: true });
  await waiting;
  assert.equal(verified, true);
});
test('legacy failed sessions park without claiming final export and stopped containers consume no resident slot', async () => {
  const task = { id: 'legacy', finalization: { failedTurnId: 'turn' } },
    called = [];
  const q = new FinalizationQueue({
    runtime: {
      load: () => ({ status: 'running', terminal: {} }),
      parkCompleted: async () => called.push('park'),
      close: async () => called.push('close'),
    },
    refresh: async () => [task],
  });
  q.enqueue([task], new Set());
  await Promise.all(q.active.values());
  assert.deepEqual(called, ['park']);
});
test('attempt timing preserves previous attempts and clock corrections never produce negative duration', async (t) => {
  const dir = temp(t);
  let now = 200;
  const options = {
    dir,
    taskId: 'task',
    turnId: 'turn',
    release: 'one',
    now: () => now,
  };
  const first = attemptTiming(options);
  await assert.rejects(
    first.stage('score', async () => {
      now = 100;
      throw Error('failed');
    }),
  );
  first.finish('failed');
  const old = readFileSync(first.file, 'utf8');
  now = 300;
  const second = attemptTiming({ ...options, release: 'two' });
  await second.stage('score', async () => {
    now = 450;
  });
  second.finish('completed');
  assert.ok(readFileSync(first.file, 'utf8').startsWith(old));
  const summary = summarizeTiming(first.file);
  assert.equal(summary.length, 2);
  assert.equal(summary[0].elapsedMs, 0);
  assert.equal(summary[1].elapsedMs, 150);
});
function task(action = 'advance') {
  return {
    id: 'task',
    closed: false,
    container: {
      questionId: 'one',
      containerId: 'c'.repeat(64),
      status: 'running',
    },
    turns: [
      {
        id: 'one',
        questionRootId: 'one',
        status: 'review',
        automation: { next: { value: { action } } },
      },
      ...(action === 'advance'
        ? [{ id: 'two', questionRootId: 'two', status: 'queued' }]
        : []),
    ],
  };
}
test('completed session closes with independent queued successor; legal Bug and unknown activity stay open', () => {
  assert.equal(sessionFinalization(task()).reason, 'completed-session');
  assert.equal(sessionFinalization(task('repair')), null);
  const same = task();
  same.turns[1].questionRootId = 'one';
  assert.equal(sessionFinalization(same), null);
  const running = task();
  running.turns[1].status = 'running';
  assert.equal(sessionFinalization(running), null);
  const blocked = task();
  blocked.turns[0].recoveryBlocked = true;
  assert.equal(sessionFinalization(blocked), null);
  assert.equal(
    sessionFinalization(task('needs_input')).reason,
    'needs-attention',
  );
});
test('failure finalization requires completed native identity, leaves failed status and passes selected failed turn', () => {
  const t = task('needs_input');
  const r = t.turns[0];
  r.status = 'failed';
  r.executionOutcome = 'error';
  assert.equal(sessionFinalization(t), null);
  r.traceExport = { verified: true };
  r.promptId = 'native';
  r.sessionId = 'session';
  r.permissionAudit = { passed: true };
  assert.equal(sessionFinalization(t).failedTurnId, 'one');
  r.permissionAudit.passed = false;
  assert.equal(sessionFinalization(t).reason, 'completed-quality-failure');
  assert.equal(r.status, 'failed');
});
test('explicit close admits rejected unused containers but never unknown active input', () => {
  const t = task('needs_input');
  t.turns[0].status = 'failed';
  t.closed = true;
  assert.equal(sessionFinalization(t).reason, 'operator-closed');
  t.turns[0].recoveryBlocked = true;
  assert.equal(sessionFinalization(t), null);
});
test('finalization has one global export and then advances past completed records', async () => {
  const a = { id: 'a', finalization: { questionId: 'a' } },
    b = { id: 'b', finalization: { questionId: 'b' } };
  const gate = deferred(),
    calls = [];
  const q = new FinalizationQueue({
    runtime: {
      load: () => ({ terminal: { terminalProtocolVersion } }),
      close: async (id) => {
        calls.push(id);
        if (id === 'a') await gate.promise;
      },
    },
    refresh: async () => [a, b],
  });
  q.enqueue([a, b], new Set());
  await tick();
  q.enqueue([a, b], new Set());
  await tick();
  assert.deepEqual(calls, ['a']);
  gate.resolve();
  await Promise.all(q.active.values());
  q.enqueue([a, b], new Set());
  await Promise.all(q.active.values());
  assert.deepEqual(calls, ['a', 'b']);
});
test('lightweight admission reserves verifier memory and never grants it under pressure', () => {
  const GiB = 2 ** 30,
    profile = resourceProfile('lightweight');
  const engine = {
    ready: true,
    memoryBytes: 8 * GiB,
    resourceSample: {
      ok: true,
      externalWorkingSetBytes: 1.3 * GiB,
      ownedContainers: Array.from({ length: 3 }, () => ({
        memoryLimitBytes: 1.5 * GiB,
      })),
    },
  };
  assert.equal(projectCapacityWithVerifier(engine, profile), 3);
  assert.equal(heavyMemoryBudget(engine, profile), GiB);
  engine.resourceSample.ownedContainers.push({ memoryLimitBytes: 1.5 * GiB });
  assert.equal(heavyMemoryBudget(engine, profile), 0);
  engine.resourceSample.ownedContainers = [];
  engine.resourceSample.vmObserved = true;
  engine.resourceSample.memAvailableBytes = 4 * GiB;
  engine.resourceSample.pressure = { someAvg10: 11 };
  assert.equal(heavyMemoryBudget(engine, profile), 0);
});
test('actual Docker VM budget can admit three light projects and a 768 MiB verifier without overcommit', () => {
  const profile = resourceProfile('lightweight');
  const e = {
    ready: true,
    memoryBytes: 8217059328,
    resourceSample: {
      ok: true,
      externalWorkingSetBytes: 1267780812.8,
      ownedContainers: Array.from({ length: 3 }, () => ({
        memoryLimitBytes: profile.memoryBytes,
      })),
    },
  };
  assert.equal(projectCapacityWithVerifier(e, profile), 3);
  assert.equal(heavyMemoryBudget(e, profile), 768 * 2 ** 20);
  assert.ok(
    3 * profile.memoryBytes +
      e.resourceSample.externalWorkingSetBytes +
      profile.dockerReserveBytes +
      heavyMemoryBudget(e, profile) <=
      e.memoryBytes,
  );
});
test('pilot opens only after a real successful chain with original terminal and clean permissions', (t) => {
  const gate = new PilotGate(temp(t));
  gate.save({ status: 'pilot' });
  gate.admit('a', 'q');
  const good = {
    questionId: 'q',
    status: 'removed',
    traceExport: { verified: true, sha256: 'a'.repeat(64) },
    finalCommandTransport: 'original-mac-terminal',
    permissionAudit: { passed: true },
    results: { turn: { success: true } },
  };
  for (const state of [
    { ...good, results: {} },
    { ...good, permissionAudit: { passed: false } },
    { ...good, finalCommandTransport: 'background' },
    { ...good, results: { turn: { success: false } } },
  ]) {
    gate.finalized('a', state);
    assert.equal(gate.capacity(3), 1);
  }
  gate.finalized('b', good);
  assert.equal(gate.capacity(3), 1);
  gate.finalized('a', good);
  assert.equal(gate.capacity(3), 3);
});
test('source hash cache invalidates same-size source writes even with restored mtime', async (t) => {
  const file = path.join(temp(t), 'source.js');
  writeFileSync(file, 'one');
  const before = lstatSync(file),
    cache = new SourceHashCache(),
    original = cache.read(file, before);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeFileSync(file, 'two');
  utimesSync(file, before.atime, before.mtime);
  assert.notEqual(cache.read(file, lstatSync(file)), original);
});
test('persisted provider circuit survives restart and releases an abandoned probe', (t) => {
  const file = path.join(temp(t), 'health.json');
  let now = 0;
  const p = new ProviderHealth({ file, now: () => now, pauseMs: 500 });
  p.observe('a', { executionOutcome: 'error', promptId: 'a' });
  p.release('a');
  p.observe('b', { executionOutcome: 'error', promptId: 'b' });
  p.release('b');
  const restored = new ProviderHealth({ file, now: () => now, pauseMs: 500 });
  assert.equal(restored.canAdmit(), false);
  now = 600;
  restored.admit('probe');
  const next = new ProviderHealth({ file, now: () => now });
  assert.equal(next.canAdmit(), false);
  next.reconcile(['probe']);
  assert.equal(next.canAdmit(), false);
  next.reconcile([]);
  assert.equal(next.canAdmit(), true);
});
test('next-job release switch leaves previously loaded executor pinned', async (t) => {
  const dir = temp(t);
  const modules = [];
  for (const [name, commit] of [
    ['one', 'a'],
    ['two', 'b'],
  ]) {
    const root = path.join(dir, 'releases', name);
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const files = [
      [
        'scripts/job-executor.mjs',
        `export const executorProtocolVersion='${jobReleaseProtocol}';export const createJobExecutor=()=>()=> '${name}';export const createJobRuntime=()=>({});`,
      ],
      ['scripts/docker-runtime.mjs', 'export const ok=true;'],
      ['package.json', '{"type":"module"}'],
    ];
    for (const [p, bytes] of files) writeFileSync(path.join(root, p), bytes);
    const manifest = JSON.stringify({
      protocol: jobReleaseProtocol,
      commit: commit.repeat(40),
      files: files.map(([p, bytes]) => ({ path: p, sha256: sha(bytes) })),
    });
    writeFileSync(path.join(root, 'job-release.json'), manifest);
    writeFileSync(
      path.join(dir, 'job-release-current.json'),
      JSON.stringify({ root, manifestSha256: sha(manifest) }),
    );
    modules.push((await loadJobRelease(dir)).module.createJobExecutor());
  }
  assert.equal(modules[0](), 'one');
  assert.equal(modules[1](), 'two');
});
test('finalization queue owns lock before awaiting, revalidates before exit, and never touches legacy or busy sessions', async () => {
  const t = task();
  t.finalization = sessionFinalization(t);
  const gate = deferred();
  let calls = 0;
  const runtime = {
    load: () => ({ status: 'running', terminal: { terminalProtocolVersion } }),
    close: async (_id, opts) => {
      await opts.beforeExit();
      calls++;
      await gate.promise;
    },
  };
  const q = new FinalizationQueue({ runtime, refresh: async () => [t] });
  q.enqueue([t], new Set());
  assert.ok(q.active.has(t.id));
  q.enqueue([t], new Set());
  await tick();
  assert.equal(calls, 1);
  gate.resolve();
  await Promise.all(q.active.values());
  q.enqueue([t], new Set([t.id]));
  assert.equal(q.active.size, 0);
  runtime.load = () => ({ status: 'running', terminal: {} });
  q.enqueue([t], new Set());
  assert.equal(q.active.size, 0);
});
test('changed finalization decision backs off without sending exit', async () => {
  const t = task();
  t.finalization = sessionFinalization(t);
  let calls = 0;
  const q = new FinalizationQueue({
    runtime: {
      load: () => ({ terminal: { terminalProtocolVersion } }),
      close: async () => {
        calls++;
      },
    },
    refresh: async () => [],
    now: () => 100,
  });
  q.enqueue([t], new Set());
  await Promise.all(q.active.values());
  assert.equal(calls, 0);
  q.enqueue([t], new Set());
  assert.equal(q.active.size, 0);
  assert.equal(q.retryAt.get(t.id), 60100);
});
test('two qualified candidates buffer is bounded; generation can use an idle phase without a fourth project', () => {
  const c = {
    config: { enabled: true, dailyLimit: 20 },
    repos: ['/repo'],
    generatedToday: 1,
    history: [],
    queuedCount: 1,
    candidateBuffer: 2,
  };
  assert.equal(supplyDecision(c, {}), null);
  assert.ok(supplyDecision({ ...c, queuedCount: 2 }, {}));
  assert.equal(
    canReplenish(c, {}, { capacity: 3, active: 3, stageAvailable: true }),
    true,
  );
  assert.equal(
    canReplenish(c, {}, { capacity: 3, active: 3, stageAvailable: false }),
    false,
  );
});
test('cross-project provider circuit backs off, admits one real job, and recovers only from actual output', () => {
  let now = 100;
  const p = new ProviderHealth({ now: () => now, pauseMs: 500 });
  const error = { executionOutcome: 'error', promptId: 'p' };
  p.observe('a', error);
  assert.ok(p.canAdmit());
  p.observe('b', error);
  assert.equal(p.canAdmit(), false);
  now = 601;
  assert.ok(p.canAdmit());
  p.admit('c');
  assert.equal(p.canAdmit(), false);
  p.observe('c', { executionOutcome: 'complete', promptId: 'p' });
  assert.ok(p.canAdmit());
  assert.equal(p.failures.size, 0);
  p.observe('a', { ...error, permissionAudit: { passed: false } });
  assert.equal(p.failures.size, 0);
});
test('native inactivity thresholds are diagnostics only; no fabricated progress or resend', () => {
  const w = new NativeProgressWatch(1800000, 100);
  assert.equal(w.diagnostics(600100).level, 'observe');
  assert.equal(w.diagnostics(1200100).level, 'terminal-review-due');
  assert.equal(w.diagnostics(1200100).automaticResend, false);
});
test('immutable job release rejects code edits, incompatible protocols and roots outside release directory', (t) => {
  const dir = temp(t),
    root = path.join(dir, 'releases', 'one');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const files = [
    ['scripts/job-executor.mjs', 'export const x=1;'],
    ['scripts/docker-runtime.mjs', 'export const y=2;'],
    ['package.json', '{"type":"module"}'],
  ];
  for (const [name, data] of files) writeFileSync(path.join(root, name), data);
  const bytes = JSON.stringify({
    protocol: jobReleaseProtocol,
    commit: 'a'.repeat(40),
    files: files.map(([name, data]) => ({ path: name, sha256: sha(data) })),
  });
  writeFileSync(path.join(root, 'job-release.json'), bytes);
  const pointer = { root, manifestSha256: sha(bytes) };
  assert.equal(verifyJobRelease(pointer, dir).commit, 'a'.repeat(40));
  writeFileSync(path.join(root, 'scripts/job-executor.mjs'), 'changed');
  assert.throws(() => verifyJobRelease(pointer, dir), /变化/);
});
test('scaffold readiness requires bounded executable startup and smoke checks', () => {
  assert.throws(() =>
    validateReadiness({ port: 80, startCommand: 'x', smokeCommand: 'x' }),
  );
  assert.throws(() =>
    validateReadiness({ port: 8080, startCommand: 'x', smokeCommand: '' }),
  );
  assert.equal(
    validateReadiness({
      port: 8080,
      startCommand: 'node app.js',
      smokeCommand: 'node --test',
    }).port,
    8080,
  );
});
