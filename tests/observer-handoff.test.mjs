import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handoffTerminalObservers } from '../scripts/observer-handoff.mjs';
import {
  queueObserverHandoff,
  upgradeHandoffReady,
} from '../lib/observer-handoff.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
import { saveJSON, readJSON } from '../scripts/self-heal-io.mjs';

test('observer replacement survives a lost acknowledgement and signals only the old observer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-handoff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, '.runner'),
    taskId = 'task',
    turnId = 'turn';
  const terminalFile = path.join(
    work,
    taskId,
    'questions',
    turnId,
    'terminal/state.json',
  );
  const state = {
    taskId,
    questionId: turnId,
    containerId: 'container',
    status: 'running',
    terminal: { statePath: terminalFile, runId: 'original-terminal' },
    pending: { turnId, phase: 'sent', count: 1, promptHash: 'a'.repeat(64) },
  };
  const terminal = {
    status: 'running',
    realTerminal: true,
    runId: 'original-terminal',
    pid: 200,
    childPid: 201,
  };
  saveJSON(terminalFile, terminal);
  saveJSON(path.join(work, taskId, turnId + '.job.json'), {
    taskId,
    turnId,
    jobToken: 'original-job',
    children: [],
  });
  fs.writeFileSync(path.join(root, '.dev.vars'), 'RUNNER_TOKEN=fixture-only\n');
  const turn = {
    id: turnId,
    status: 'running',
    stage: 'claude',
    claudeAttempts: ['one'],
    jobToken: 'original-job',
  };
  const task = { id: taskId, container: state, turns: [turn] };
  const data = {
    tasks: [task],
    runner: {
      scheduler: {
        draining: true,
        active: 1,
        stages: { running: [{ kind: 'claude' }] },
      },
    },
  };
  const signals = [];
  let loseAcknowledgement = true;
  const deps = {
    identity: (pid) => ([100, 200, 201].includes(pid) ? 'fixture-' + pid : ''),
    ownedRunnerRoot: () => root,
    signal: (...args) => signals.push(args),
    runtime: { load: () => state, owned: () => ({ State: { Running: true } }) },
    localAPI: async (route, options) => {
      assert.equal(route, '/api/runner');
      assert.equal(options.headers.authorization, 'Bearer fixture-only');
      const request = JSON.parse(options.body);
      queueObserverHandoff(task, turn, request);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw Error('lost HTTP acknowledgement');
      }
      return { ok: true };
    },
  };
  const before = structuredClone(state);
  await assert.rejects(
    handoffTerminalObservers(root, 100, data, deps),
    /lost HTTP acknowledgement/,
  );
  assert.deepEqual(signals, []);
  assert.equal(turn.status, 'queued');
  assert.equal(await handoffTerminalObservers(root, 100, data, deps), true);
  assert.deepEqual(signals, [[100, 'SIGTERM']]);
  assert.deepEqual(state, before);
  assert.deepEqual(readJSON(terminalFile), terminal);
  assert.deepEqual(turn.claudeAttempts, ['one']);
  assert.equal(
    readJSON(path.join(work, 'self-heal/observer-handoff.json')).state,
    'observer-stopping',
  );
  // A surviving non-Terminal stage must never be interrupted for an upgrade.
  data.runner.scheduler.stages.running = [{ kind: 'heavy' }];
  assert.equal(await handoffTerminalObservers(root, 100, data, deps), false);
  assert.equal(signals.length, 1);
});

test('resumed observer refuses a missing sent receipt before touching the session', async () => {
  const runtime = Object.create(DockerRuntime.prototype);
  runtime.load = () => ({
    containerId: 'container',
    questionId: 'turn',
    terminal: { runId: 'terminal' },
  });
  const turn = {
    id: 'turn',
    observerHandoff: {
      containerId: 'container',
      sessionId: null,
      terminalRunId: 'terminal',
      promptHash: 'a'.repeat(64),
    },
  };
  await assert.rejects(
    runtime.ensure({ id: 'task', turns: [turn] }, turn),
    /禁止重发/,
  );
});

test('busy upgrades keep free slots open until every active job is a transferable observer', () => {
  const state = {
    active: 3,
    recovering: 0,
    generating: false,
    finalizing: 0,
    running: [{ kind: 'claude' }, { kind: 'codex' }, { kind: 'claude' }],
  };
  assert.equal(upgradeHandoffReady(true, state), false);
  assert.equal(
    upgradeHandoffReady(true, {
      ...state,
      active: 1,
      running: [{ kind: 'codex' }],
    }),
    false,
  );
  const observers = {
    ...state,
    running: [{ kind: 'claude' }, { kind: 'claude' }, { kind: 'claude' }],
  };
  assert.equal(upgradeHandoffReady(true, observers), true);
  assert.equal(upgradeHandoffReady(false, observers), false);
  for (const busy of [
    { recovering: 1 },
    { generating: true },
    { finalizing: 1 },
  ])
    assert.equal(upgradeHandoffReady(true, { ...observers, ...busy }), false);
  assert.equal(
    upgradeHandoffReady(true, { ...state, active: 0, running: [] }),
    true,
  );
});
