import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BoundaryFinalizer } from '../scripts/boundary-finalizer.mjs';
import { FinalizationQueue } from '../scripts/finalization-queue.mjs';
import { terminalProtocolVersion } from '../scripts/mac-terminal.mjs';
import { recordDeliveryHistory } from '../lib/production-history.mjs';
import {
  operationsSnapshot,
  validateOperations,
} from '../lib/operations-status.mjs';
import { repairMetrics } from '../scripts/repair-metrics.mjs';
import { throughputReport } from '../scripts/throughput-report.mjs';
import { knownRecovery, knownRecoveryDue } from '../scripts/known-recovery.mjs';
import { archivedPredecessor } from '../lib/project-recovery.mjs';
import { saveJSON } from '../scripts/self-heal-io.mjs';
import { monitorTask } from '../lib/monitor-source.mjs';
import { selfHealConditions } from '../lib/recovery-conditions.mjs';
import { recoveryAction } from '../lib/self-heal.mjs';
const digest = (b) => createHash('sha256').update(b).digest('hex');
const at = Date.parse('2026-09-12T08:00:00Z');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function defer() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('archive acknowledgement loss, restart and code adoption recover once without replaying export or disturbing live projects', async (t) => {
  const root = temp(t),
    native = path.join(root, 'native.jsonl'),
    raw = Buffer.from('{"type":"user","message":"原件保持原样"}\n');
  fs.writeFileSync(native, raw);
  let now = at,
    completions = 0,
    removals = 0,
    fail = true;
  const state = {
    taskId: 'archive',
    questionId: 'q',
    containerId: 'container',
    status: 'stopped',
    terminal: { terminalProtocolVersion, runId: 'run' },
  };
  const task = {
    id: 'archive',
    finalization: { questionId: 'q', containerId: 'container', turnId: 'turn' },
  };
  const runtime = {
    root,
    load: () => state,
    detach() {},
    close: async () => {
      assert.deepEqual(fs.readFileSync(native), raw);
      if (state.status !== 'removed') {
        removals++;
        state.status = 'removed';
        state.traceExport = { verified: true, sha256: digest(raw) };
      }
      if (fail) {
        fail = false;
        throw Error('原终端尚未确认最终完成，保留窗口');
      }
      completions++;
    },
  };
  const options = {
    runtime,
    refresh: async () => [task],
    now: () => now,
    onComplete: async () => {},
  };
  let queue = new FinalizationQueue({ ...options, revision: 'old' });
  queue.enqueue([task], new Set(['live1', 'live2', 'live3']));
  await Promise.all(queue.active.values());
  assert.equal(queue.failures.archive.waitForChange, false);
  assert.equal(removals, 1);
  queue = new FinalizationQueue({ ...options, revision: 'old' }); // simulated owner restart
  queue.enqueue([task], new Set());
  assert.equal(queue.active.size, 0);
  now += 60001;
  queue.enqueue([task], new Set());
  await Promise.all(queue.active.values());
  assert.equal(completions, 1);
  assert.equal(removals, 1);
  assert.deepEqual(queue.failures, {});
  queue.enqueue([task], new Set());
  assert.equal(queue.active.size, 0);
  assert.deepEqual(fs.readFileSync(native), raw);
});

test('a verified version changes the finalizer only between exports and survives a broken candidate', async () => {
  let release = 'v1',
    detached = 0,
    active = new Map();
  const created = [];
  const boundary = new BoundaryFinalizer({
    load: async () => ({ commit: release }),
    create: (r) => {
      if (r.commit === 'broken') throw Error('bad candidate');
      const q = {
        active: new Map(),
        completed: new Map(),
        runtime: {
          detach() {
            detached++;
          },
        },
        enqueue() {},
      };
      created.push(q);
      return q;
    },
  });
  await boundary.adopt();
  active = boundary.active;
  const gate = defer();
  active.set('export', gate.promise);
  release = 'v2';
  assert.equal(await boundary.adopt(), false);
  assert.equal(boundary.revision, 'v1');
  assert.equal(detached, 0);
  gate.resolve();
  await gate.promise;
  active.delete('export');
  assert.equal(await boundary.adopt(), true);
  assert.equal(boundary.revision, 'v2');
  assert.equal(detached, 1);
  release = 'broken';
  await assert.rejects(boundary.adopt(), /bad candidate/);
  assert.equal(boundary.revision, 'v2');
  assert.equal(boundary.active, created[1].active);
});

test('callback failure stays durable; new code can finish the same plan while an unknown pending native input is never closed', async (t) => {
  const root = temp(t);
  let now = at,
    fail = true,
    closed = 0;
  const state = {
    questionId: 'q',
    containerId: 'c',
    status: 'removed',
    terminal: { terminalProtocolVersion },
    traceExport: { verified: true },
  };
  const task = { id: 't', finalization: { questionId: 'q', containerId: 'c' } };
  const options = {
    runtime: { root, load: () => state, close: async () => closed++ },
    refresh: async () => [task],
    now: () => now,
    onComplete: async () => {
      if (fail) throw Error('交付回填未完成');
    },
  };
  let q = new FinalizationQueue({ ...options, revision: 'before' });
  q.enqueue([task], new Set());
  await Promise.all(q.active.values());
  assert.equal(q.completed.size, 0);
  assert.equal(q.failures.t.waitForChange, true);
  now += 60001;
  q = new FinalizationQueue({ ...options, revision: 'before' });
  q.enqueue([task], new Set());
  assert.equal(q.active.size, 0);
  state.pending = { phase: 'sent' };
  q = new FinalizationQueue({ ...options, revision: 'after' });
  q.enqueue([task], new Set());
  assert.equal(q.active.size, 0);
  delete state.pending;
  fail = false;
  q.enqueue([task], new Set());
  await Promise.all(q.active.values());
  assert.equal(q.completed.size, 1);
  assert.equal(closed, 2);
  assert.deepEqual(q.failures, {});
});

test('fixed source recovery verifies source bytes and keeps one intent per actual condition', (t) => {
  const root = temp(t),
    dir = path.join(root, 'source');
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  const source = 'export const app = true;';
  fs.writeFileSync(path.join(dir, 'workspace/app.js'), source);
  const manifest = JSON.stringify({
    files: [{ name: 'workspace/app.js', sha256: digest(source) }],
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  const turn = {
    id: 'turn',
    status: 'review',
    automation: { nextError: 'source unavailable' },
    projectRecovery: {
      sourceSnapshot: {
        verified: true,
        manifestPath: path.join(dir, 'manifest.json'),
        manifestSha256: digest(manifest),
      },
    },
  };
  const snapshot = { tasks: [{ id: 't', turns: [turn] }] },
    incident = {
      taskId: 't',
      turnId: 'turn',
      conditionsKey: 'conditions-a',
      reason: '无法读取冻结源码',
    };
  const action = knownRecovery(root, incident, snapshot);
  assert.equal(action.id, 'verified-source-replan');
  assert.equal(action.action, 'retry-plan');
  incident.fixedRecoveries = [
    { ...action, conditionsKey: incident.conditionsKey, state: 'intent' },
  ];
  assert.equal(knownRecoveryDue(incident, action), false);
  incident.conditionsKey = 'conditions-b';
  assert.equal(knownRecoveryDue(incident, action), true);
  fs.writeFileSync(path.join(dir, 'workspace/app.js'), 'tampered');
  assert.throws(() => knownRecovery(root, incident, snapshot), /摘要不符/);
});

test('archived predecessor never supplies a reserved call, foreign container or denied session', () => {
  const previous = {
    id: 'old',
    status: 'review',
    executionOutcome: 'complete',
    sessionId: 's',
    promptId: 'p',
    permissionAudit: { passed: true },
    traceExport: { verified: true },
    automation: { archive: { manifestSha256: 'a'.repeat(64) } },
  };
  const turn = {
    id: 'draft',
    questionRootId: 'draft',
    status: 'failed',
    stage: 'context',
  };
  const task = { id: 't', turns: [previous, turn] },
    container = {
      taskId: 't',
      questionId: 'old',
      status: 'removed',
      sessionId: 's',
      traceExport: { verified: true },
      terminal: { runId: 'run' },
    };
  assert.equal(archivedPredecessor(task, turn, container), previous);
  assert.equal(
    archivedPredecessor(
      task,
      { ...turn, claudeAttempts: ['reserved'] },
      container,
    ),
    null,
  );
  assert.equal(
    archivedPredecessor(task, turn, { ...container, taskId: 'foreign' }),
    null,
  );
  previous.permissionAudit.passed = false;
  assert.equal(archivedPredecessor(task, turn, container), null);
});

test('first delivery, revalidation and missing legacy history are counted separately', (t) => {
  const root = temp(t),
    turn = { id: 'turn' },
    result = {
      success: true,
      automation: { delivery: { value: { passed: true } } },
    };
  turn.productionHistory = recordDeliveryHistory(
    turn,
    result,
    new Date(at).toISOString(),
  );
  turn.automation = result.automation;
  turn.productionHistory = recordDeliveryHistory(
    turn,
    result,
    new Date(at + 1000).toISOString(),
  );
  assert.equal(turn.productionHistory.revalidationCount, 1);
  const legacy = { id: 'legacy', automation: result.automation };
  legacy.productionHistory = recordDeliveryHistory(
    legacy,
    result,
    new Date(at + 2000).toISOString(),
  );
  assert.equal(legacy.productionHistory.firstDeliveredAt, null);
  assert.equal(legacy.productionHistory.historicalBaseline, true);
  assert.equal(
    recordDeliveryHistory(turn, { success: false }),
    turn.productionHistory,
  );
  const report = throughputReport({
    tasks: [{ id: 't', turns: [turn, legacy] }],
    workRoot: root,
    now: new Date(at + 3000).toISOString(),
  });
  assert.equal(report.flow.firstDeliveries24h, 1);
  assert.equal(report.flow.revalidations24h, 2);
});

test('repair usage counts real stage starts, preserves missing usage and never attributes a rejected patch as a recovery', (t) => {
  const root = temp(t),
    state = {
      incidents: { fault: { taskId: 't', state: 'resolved' } },
      jobs: [
        { id: 'j', incidentId: 'fault', startedAt: new Date(at).toISOString() },
      ],
    };
  const dir = path.join(root, '.runner/self-heal/jobs/j');
  saveJSON(path.join(dir, 'job.json'), {
    id: 'j',
    state: 'failed',
    startedAt: new Date(at).toISOString(),
    updatedAt: new Date(at + 1000).toISOString(),
  });
  fs.writeFileSync(
    path.join(dir, 'fix.events.jsonl'),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 50, output_tokens: 10 },
    }) + '\n',
  );
  fs.writeFileSync(path.join(dir, 'review.events.jsonl'), 'partial output');
  const report = repairMetrics(root, state, at + 2000);
  assert.equal(report.modelInvocations, 2);
  assert.equal(report.usageKnown, 1);
  assert.equal(report.inputTokens, 50);
  assert.equal(report.restored, 0);
});

test('operational status distinguishes stalled, progressing, queued repair and current owner without old incident noise', () => {
  const checkedAt = new Date(at).toISOString(),
    tasks = ['stalled', 'working', 'blocked'].map((id) => ({
      id,
      title: id,
      projectSeries: {},
      turns: [
        {
          id: 'turn',
          status: id === 'blocked' ? 'failed' : 'running',
          stage: id === 'working' ? 'score' : 'claude',
        },
      ],
    }));
  const state = {
    checkedAt,
    activeJob: 'job',
    jobs: [],
    health: {
      progress: {},
      incidents: [
        { id: 'stalled:turn', state: 'stalled_running', reason: '无进展' },
        { id: 'blocked:turn', state: 'open', reason: '需要处理' },
      ],
    },
    incidents: {
      old: { taskId: 'working', turnId: 'old', state: 'needs_input' },
      current: {
        taskId: 'blocked',
        turnId: 'turn',
        observedAt: checkedAt,
        state: 'repairing',
        jobId: 'job',
      },
    },
  };
  const report = operationsSnapshot({
    tasks,
    state,
    config: { enabled: true, repairEnabled: true },
    now: at,
  });
  validateOperations(report);
  assert.deepEqual(
    report.projects.map((p) => p.status),
    ['stalled', 'processing', 'repairing'],
  );
  assert.throws(
    () => validateOperations({ ...report, checkedAt: 'invalid' }),
    /格式/,
  );
});
test('compact monitoring preserves recovery identity and excludes large model text and execution tokens', () => {
  const turn = {
    id: 'r',
    status: 'review',
    stage: 'delivery',
    jobToken: 'private',
    prompt: 'large'.repeat(100000),
    output: 'huge'.repeat(100000),
    sessionId: 's',
    promptId: 'p',
    traceExport: { verified: true, sha256: 'raw' },
    permissionAudit: { passed: true },
    automation: {
      nextError: 'source read failed',
      archive: { manifestSha256: 'archive' },
    },
  };
  const task = {
    id: 't',
    title: 'fixture',
    projectSeries: {},
    turns: [turn],
    container: {
      questionId: 'q',
      containerId: 'c',
      status: 'removed',
      traceExport: { verified: true, sha256: 'native' },
      terminal: { runId: 'original' },
    },
  };
  const compact = monitorTask(task),
    i = { taskId: 't', turnId: 'r', stage: 'delivery' },
    snap = {
      tasks: [task],
      config: {},
      health: { incidents: [], progress: {} },
    };
  assert.equal(
    selfHealConditions(i, snap),
    selfHealConditions(i, { ...snap, tasks: [compact] }),
  );
  assert.equal(
    recoveryAction(task, turn),
    recoveryAction(compact, compact.turns[0]),
  );
  assert.equal(compact.turns[0].jobToken, undefined);
  assert.equal(compact.turns[0].prompt, undefined);
  assert.ok(JSON.stringify(compact).length < 2000);
});
