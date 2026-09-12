import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  reconcileSelfHeal,
  nextSelfHealAction,
  selfHealDefaults,
  recoveryAction,
  digest,
} from '../lib/self-heal.mjs';
import { repairPathAllowed, validateRepair } from '../lib/self-heal-patch.mjs';
import { repairJob, runCheck } from '../scripts/self-heal-repair.mjs';
import {
  command,
  saveJSON,
  ownedRunnerRoot,
} from '../scripts/self-heal-io.mjs';
import { jobReleaseProtocol } from '../scripts/job-release.mjs';
import {
  createWakeSignal,
  wakeSelfHeal,
  wakeProtocol,
} from '../scripts/self-heal-wakeup.mjs';
import {
  advanceRelease,
  prepareBuildDependencies,
  runnerHasWork,
} from '../scripts/self-heal-release.mjs';
import { identity } from '../scripts/recovery.mjs';
import {
  summarizeNativeEvidence,
  sentPromptEvidence,
} from '../scripts/self-heal-evidence.mjs';
import { selfHealConditions } from '../lib/recovery-conditions.mjs';
import { gatewayContinuationVersion } from '../lib/gateway-continuation.mjs';

const at = Date.parse('2026-09-12T02:00:00Z');
test(
  'scheduler adoption finds the real older owned release after multiple job publications',
  { skip: process.env.SELF_HEAL_TEST === '1' },
  async (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'runner-owner-')),
    );
    const old = path.join(root, '.runner/releases/old');
    fs.mkdirSync(path.join(old, 'scripts'), { recursive: true });
    const entries = {
      'scripts/runner.mjs': 'console.log("ready");setInterval(()=>{},1000);',
      'scripts/job-executor.mjs': 'export const fixture = true;',
      'scripts/docker-runtime.mjs': 'export const fixture = true;',
      'package.json': '{"type":"module"}',
    };
    for (const [file, text] of Object.entries(entries))
      fs.writeFileSync(path.join(old, file), text);
    saveJSON(path.join(old, 'job-release.json'), {
      protocol: jobReleaseProtocol,
      commit: 'a'.repeat(40),
      files: Object.entries(entries).map(([file, text]) => ({
        path: file,
        sha256: digest(text),
      })),
    });
    saveJSON(path.join(root, '.runner/job-release-current.json'), {
      root: path.join(root, '.runner/releases/new'),
      manifestSha256: 'b'.repeat(64),
    });
    const child = spawn(process.execPath, ['scripts/runner.mjs'], {
      cwd: old,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    await once(child.stdout, 'data');
    assert.equal(ownedRunnerRoot(root, child.pid), old);
    assert.throws(
      () => ownedRunnerRoot(path.join(root, 'unrelated'), child.pid),
      /归属|不属于|ENOENT/,
    );
    fs.writeFileSync(path.join(old, 'scripts/docker-runtime.mjs'), 'changed');
    assert.throws(() => ownedRunnerRoot(root, child.pid), /代码已变化/);
  },
);
test('native diagnosis binds the sent preparation hash rather than the API draft', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prompt = '实际发送的网页需求',
    pending = { turnId: 'turn', promptHash: digest(prompt) };
  saveJSON(path.join(dir, 'turn.attempt-1.prepare.json'), {
    prompt: '早期草稿',
  });
  saveJSON(path.join(dir, 'turn.attempt-2.writing.prepare.json'), { prompt });
  saveJSON(path.join(dir, 'other.attempt-2.prepare.json'), {
    prompt: '其他题',
  });
  const sent = sentPromptEvidence(dir, 'turn', pending);
  const content =
    JSON.stringify({ type: 'user', uuid: 'u', message: { content: prompt } }) +
    '\n';
  assert.equal(
    summarizeNativeEvidence([{ name: 'native.jsonl', content }], sent.prompt)[0]
      .users[0].exactMatch,
    true,
  );
  assert.match(sent.path, /attempt-2.writing.prepare/);
  assert.throws(
    () =>
      sentPromptEvidence(dir, 'turn', {
        ...pending,
        promptHash: digest(' ' + prompt),
      }),
    /找不到/,
  );
  assert.throws(() => sentPromptEvidence(dir, 'other', pending), /缺少本轮/);
  fs.rmSync(sent.path);
  fs.symlinkSync(path.join(dir, 'other.attempt-2.prepare.json'), sent.path);
  assert.throws(() => sentPromptEvidence(dir, 'turn', pending), /找不到/);
});

test('native diagnosis reads an existing 504 continuation checkpoint without rewriting history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const turn = {
    id: 'next',
    prompt: '继续',
    continuationOf: 'previous',
    gatewayContinuation: {
      version: gatewayContinuationVersion,
      failedTurnId: 'previous',
      failedPromptId: 'p',
      sessionId: 's',
      containerId: 'c',
      traceSha256: digest('trace'),
    },
  };
  const pending = { turnId: turn.id, promptHash: digest('继续') };
  const file = path.join(dir, 'next.stages.json');
  const stage = {
    prepare: {
      value: { prompt: '继续' },
      inheritedFrom: { turnId: 'previous' },
    },
  };
  saveJSON(file, stage);
  const original = fs.readFileSync(file);
  assert.equal(sentPromptEvidence(dir, turn.id, pending, turn).prompt, '继续');
  assert.deepEqual(fs.readFileSync(file), original);
  assert.throws(() => sentPromptEvidence(dir, turn.id, pending), /找不到/);
  assert.throws(
    () =>
      sentPromptEvidence(
        dir,
        turn.id,
        { ...pending, promptHash: digest('继续 ') },
        turn,
      ),
    /找不到/,
  );
  saveJSON(file, {
    prepare: { ...stage.prepare, inheritedFrom: { turnId: 'unrelated' } },
  });
  assert.throws(
    () => sentPromptEvidence(dir, turn.id, pending, turn),
    /找不到/,
  );
  fs.rmSync(file);
  saveJSON(path.join(dir, 'other.json'), stage);
  fs.symlinkSync(path.join(dir, 'other.json'), file);
  assert.throws(
    () => sentPromptEvidence(dir, turn.id, pending, turn),
    /找不到/,
  );
});

test('failed repair immediately escalates once, retaining evidence and avoiding identical loops', () => {
  const snap = snapshot();
  snap.recoveryRevision = 'release-a';
  let s = reconcileSelfHeal(null, snap, at);
  s = reconcileSelfHeal(s, snap, at + 61000);
  const i = Object.values(s.incidents)[0];
  i.attempts = 1;
  s.jobs.push({
    id: 'prior',
    incidentId: i.id,
    signature: i.signature,
    state: 'failed',
    startedAt: new Date(at).toISOString(),
    conditionsKey: selfHealConditions(i, snap),
  });
  s = reconcileSelfHeal(s, snap, at + 120000);
  assert.equal(s.incidents[i.id].state, 'escalation_ready');
  assert.equal(nextSelfHealAction(s, snap, at + 120000)?.mode, 'escalation');
  s.jobs.push({
    id: 'escalated',
    mode: 'escalation',
    reason: '独立复核发现补丁没有覆盖原故障',
    incidentId: i.id,
    signature: i.signature,
    state: 'failed',
    conditionsKey: selfHealConditions(i, snap),
    startedAt: new Date(at).toISOString(),
  });
  snap.tasks[0].revision = 999; // API heartbeat does not count as new evidence.
  s = reconcileSelfHeal(s, snap, at + 31 * 60000);
  assert.equal(s.incidents[i.id].state, 'needs_input');
  assert.match(s.incidents[i.id].result, /补丁没有覆盖原故障/);
  assert.equal(nextSelfHealAction(s, snap, at + 31 * 60000), null);
  snap.recoveryRevision = 'release-b';
  s = reconcileSelfHeal(s, snap, at + 32 * 60000);
  assert.equal(nextSelfHealAction(s, snap, at + 32 * 60000)?.kind, 'repair');
  assert.equal(s.incidents[i.id].attempts, 1);
  assert.equal(s.jobs.length, 2);
});
test('a diagnostic external block notifies immediately and changed evidence can reopen diagnosis', () => {
  const snap = snapshot();
  snap.recoveryRevision = 'release-a';
  let s = ready(snap);
  const i = Object.values(s.incidents)[0];
  s.jobs.push({
    id: 'missing-evidence',
    incidentId: i.id,
    state: 'needs_input',
    reason: '原件缺失，需要恢复本轮原始文件',
    conditionsKey: selfHealConditions(i, snap),
    startedAt: new Date(at).toISOString(),
  });
  s = reconcileSelfHeal(s, snap, at + 61001);
  assert.equal(s.incidents[i.id].state, 'needs_input');
  assert.match(s.incidents[i.id].result, /恢复本轮原始文件/);
  assert.equal(nextSelfHealAction(s, snap, at + 61001), null);
  snap.recoveryRevision = 'evidence-reader-fixed';
  s = reconcileSelfHeal(s, snap, at + 61002);
  assert.equal(nextSelfHealAction(s, snap, at + 61002)?.mode, 'repair');
});
test('a busy or unknown scheduler keeps admissions while future jobs adopt repairs', () => {
  const data = {
    runner: {
      scheduler: {
        active: 0,
        recovering: 0,
        generating: false,
        finalizing: 0,
        stages: { running: [] },
      },
    },
    tasks: [],
  };
  assert.equal(Boolean(runnerHasWork(data)), false);
  for (const key of ['active', 'recovering', 'generating', 'finalizing']) {
    const busy = structuredClone(data);
    busy.runner.scheduler[key] = 1;
    assert.equal(Boolean(runnerHasWork(busy)), true, key);
  }
  const observed = structuredClone(data);
  observed.tasks.push({ turns: [{ status: 'running' }] });
  assert.equal(Boolean(runnerHasWork(observed)), true);
  assert.equal(Boolean(runnerHasWork({})), true);
});
test(
  'Mac repair checks cannot write outside the tree or read copied credentials',
  { skip: process.platform !== 'darwin' || process.env.SELF_HEAL_TEST === '1' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-isolation-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cwd = path.join(dir, 'tree');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, '.dev.vars'), 'DUMMY=fixture');
    const code = `const fs=require('node:fs');try{fs.writeFileSync(${JSON.stringify(path.join(dir, 'outside'))},'bad');process.exit(11)}catch{}try{fs.readFileSync('.dev.vars');process.exit(12)}catch{};`;
    assert.equal(
      await runCheck(cwd, ['-e', code], path.join(dir, 'check.log')),
      0,
    );
    assert.equal(fs.existsSync(path.join(dir, 'outside')), false);
  },
);
function snapshot() {
  return {
    config: { enabled: true, autoContinue: true },
    tasks: [
      {
        id: 't',
        title: '项目',
        turns: [{ id: 'r', status: 'running', stage: 'claude' }],
      },
    ],
    health: {
      active: 3,
      effective: 3,
      needsAction: true,
      incidents: [
        {
          id: 't:r',
          taskId: 't',
          turnId: 'r',
          stage: 'claude',
          state: 'stalled_running',
          reason: '运行中长期没有新进展',
          lastProgressAt: new Date(at - 30 * 60000).toISOString(),
        },
      ],
      progress: {},
    },
  };
}
test('native diagnostic exposes boundary whitespace mismatch without changing source or claiming delivery', () => {
  const events = [
    { type: 'user', uuid: 'u', sessionId: 's', message: { content: ' 题目' } },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] },
    },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const content = events.map(JSON.stringify).join('\n') + '\n',
    files = [{ name: 's.jsonl', content }];
  const r = summarizeNativeEvidence(files, '题目')[0].users[0];
  assert.equal(r.exactMatch, false);
  assert.equal(r.boundaryWhitespaceMatch, true);
  assert.equal(r.durationMarkers, 1);
  assert.equal(r.pendingTools, 0);
  assert.equal(files[0].content, content);
  assert.equal(r.complete, undefined);
});
test(
  'published updates wait for the exact old runner without an elapsed-time kill',
  { skip: process.env.SELF_HEAL_TEST === '1' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-wait-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    saveJSON(path.join(root, '.runner/self-heal/deploy.json'), {
      active: true,
      jobId: 'j',
      phase: 'waiting-runner',
      oldRunnerPid: process.pid,
      oldRunnerIdentity: identity(process.pid),
      startedAt: '2000-01-01T00:00:00Z',
    });
    assert.deepEqual(
      await advanceRelease(root, { id: 'j' }, path.join(root, 'job.json')),
      { waiting: true },
    );
    assert.ok(identity(process.pid));
  },
);
test('candidate builds get private caches without replacing shared node_modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = path.join(root, 'node_modules'),
    release = path.join(root, '.runner/releases/candidate');
  fs.mkdirSync(shared);
  fs.mkdirSync(path.join(shared, 'dependency'));
  fs.mkdirSync(path.join(shared, '.vite-temp'));
  fs.mkdirSync(release, { recursive: true });
  fs.symlinkSync(shared, path.join(release, 'node_modules'));
  prepareBuildDependencies(release, root);
  const candidate = path.join(release, 'node_modules');
  assert.equal(fs.lstatSync(candidate).isDirectory(), true);
  assert.equal(
    fs.realpathSync(path.join(candidate, 'dependency')),
    fs.realpathSync(path.join(shared, 'dependency')),
  );
  assert.equal(fs.existsSync(path.join(candidate, '.vite-temp')), false);
  assert.equal(fs.existsSync(path.join(shared, '.vite-temp')), true);
});
function ready(s = snapshot()) {
  const first = reconcileSelfHeal(null, s, at);
  return reconcileSelfHeal(first, s, at + 61000);
}
test('upload faults stay open until verified receipts resolve the external event', () => {
  const s = snapshot();
  s.tasks = [];
  s.health.incidents = [
    {
      id: 'external:solo-upload:batch',
      externalKey: 'solo-upload:batch',
      stage: 'upload',
      state: 'open',
      reason: 'attachment chooser failed',
    },
  ];
  const state = ready(s),
    id = Object.keys(state.incidents)[0];
  s.health.needsAction = false;
  s.health.incidents = [];
  assert.notEqual(
    reconcileSelfHeal(state, s, at + 120000).incidents[id].state,
    'resolved',
  );
  s.health.externalResolvedIds = ['solo-upload:batch'];
  assert.equal(
    reconcileSelfHeal(state, s, at + 120000).incidents[id].state,
    'resolved',
  );
});
test('unchanged fault triggers once after confirmation, never on process heartbeat alone', () => {
  const s = snapshot(),
    a = reconcileSelfHeal(null, s, at);
  assert.equal(nextSelfHealAction(a, s, at), null);
  const b = ready(s),
    i = Object.values(b.incidents)[0];
  assert.equal(i.state, 'ready');
  assert.equal(nextSelfHealAction(b, s, at + 61000).kind, 'repair');
  b.activeJob = 'worker';
  assert.equal(nextSelfHealAction(b, s, at + 120000), null);
  assert.equal(
    reconcileSelfHeal(b, s, at + 120000).incidents[i.id].state,
    'ready',
  );
});
test('real delivery resolves a fault, existing delivery does not hide failed continuation planning', () => {
  const s = snapshot(),
    b = ready(s),
    id = Object.keys(b.incidents)[0];
  s.tasks[0].turns[0].automation = { delivery: { value: { passed: true } } };
  s.tasks[0].turns[0].status = 'review';
  assert.notEqual(
    reconcileSelfHeal(b, s, at + 120000).incidents[id].state,
    'resolved',
  );
  s.health.incidents = [];
  assert.equal(
    reconcileSelfHeal(b, s, at + 120000).incidents[id].state,
    'resolved',
  );
});
test('progress enters verification, stalled old progress does not keep extending recovery', () => {
  const s = snapshot(),
    b = ready(s),
    i = Object.values(b.incidents)[0];
  i.state = 'verifying';
  i.attempts = 2;
  i.repairedAt = new Date(at).toISOString();
  s.health.progress['t:r'] = {
    lastProgressAt: new Date(at + 60000).toISOString(),
  };
  assert.equal(
    reconcileSelfHeal(b, s, at + 21 * 60000, {
      ...selfHealDefaults,
      maxAttempts: 2,
    }).incidents[i.id].state,
    'needs_input',
  );
});
test('active Claude cannot be retried and excluded records remain held', () => {
  const s = snapshot();
  assert.equal(recoveryAction(s.tasks[0], s.tasks[0].turns[0]), null);
  s.tasks[0].turns[0].excluded = true;
  const b = ready(s);
  assert.equal(Object.values(b.incidents)[0].state, 'needs_input');
  assert.equal(nextSelfHealAction(b, s, at + 61000), null);
});
test('optional finite budgets persist, default unlimited configuration never treats null as zero', () => {
  const s = snapshot(),
    b = ready(s),
    i = Object.values(b.incidents)[0];
  const limits = { ...selfHealDefaults, maxAttempts: 2, maxRepairsPerDay: 6 };
  i.attempts = 2;
  assert.equal(
    nextSelfHealAction(JSON.parse(JSON.stringify(b)), s, at + 61000, limits),
    null,
  );
  i.attempts = 0;
  b.jobs = Array.from({ length: 6 }, () => ({
    startedAt: new Date(at).toISOString(),
    state: 'failed',
  }));
  assert.equal(nextSelfHealAction(b, s, at + 61000, limits), null);
  i.attempts = 100;
  assert.equal(nextSelfHealAction(b, s, at + 61000)?.kind, 'repair');
});

test('exhausted model budget does not hide a later protected transport retry', () => {
  const snap = snapshot();
  snap.tasks.push({
    id: 'network',
    turns: [
      {
        id: 'failed',
        status: 'failed',
        stage: 'context',
        projectRecovery: { state: 'blocked' },
      },
    ],
  });
  snap.health.incidents.push({
    id: 'network:failed',
    taskId: 'network',
    turnId: 'failed',
    stage: 'context',
    state: 'open',
    reason: 'fetch failed',
  });
  const state = ready(snap);
  state.jobs = Array.from({ length: 6 }, (_, n) => ({
    id: 'spent' + n,
    startedAt: new Date(at).toISOString(),
    state: 'failed',
  }));
  const limits = { ...selfHealDefaults, maxRepairsPerDay: 6 };
  const next = nextSelfHealAction(state, snap, at + 61000, limits);
  assert.equal(next?.kind, 'retry');
  assert.equal(state.incidents[next.incidentId].taskId, 'network');
  state.incidents[next.incidentId].directRetryAt = new Date(at).toISOString();
  assert.equal(nextSelfHealAction(state, snap, at + 120000, limits), null);
});

test('an obsolete incident cannot spend another repair call after the turn moved on', () => {
  const snap = snapshot(),
    s = ready(snap);
  snap.health.incidents = [];
  snap.tasks[0].turns[0].status = 'review';
  assert.equal(nextSelfHealAction(s, snap, at + 61000), null);
});

test('explicit failed stages are ready on observation, running stalls need confirmation', () => {
  const snap = snapshot();
  assert.equal(
    Object.values(reconcileSelfHeal(null, snap, at).incidents)[0].state,
    'observing',
  );
  snap.health.incidents[0].state = 'open';
  snap.tasks[0].turns[0].status = 'failed';
  assert.equal(
    Object.values(reconcileSelfHeal(null, snap, at).incidents)[0].state,
    'ready',
  );
});

test('event wake interrupts the wait and retains events received during a tick', async () => {
  const signal = createWakeSignal();
  const waiting = signal.wait(10000);
  signal.wake();
  await waiting;
  signal.wake();
  signal.wake();
  await signal.wait(10000);
});

test(
  'event notification signals only a registered owned guardian',
  { skip: process.env.SELF_HEAL_TEST === '1' },
  async (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-wake-')),
    );
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(
      path.join(root, 'scripts/self-heal.mjs'),
      'process.on("SIGUSR2",()=>console.log("wake"));console.log("ready");setInterval(()=>{},1000);',
    );
    const child = spawn(process.execPath, ['scripts/self-heal.mjs'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    await once(child.stdout, 'data');
    const file = path.join(root, '.runner/self-heal/state.json');
    const state = {
      pid: child.pid,
      pidIdentity: identity(child.pid),
      wakeProtocol,
    };
    saveJSON(file, { ...state, wakeProtocol: 'legacy' });
    assert.equal(wakeSelfHeal(path.join(root, '.runner')), false);
    saveJSON(file, state);
    const received = once(child.stdout, 'data');
    assert.equal(wakeSelfHeal(path.join(root, '.runner')), true);
    assert.equal(String((await received)[0]).trim(), 'wake');
  },
);
test('patch admission blocks source drift, traversal, raw data and self policy edits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const p of [
    '../lib/a.mjs',
    'scripts/../../a.mjs',
    '.runner/trace.jsonl',
    'lib/self-heal.mjs',
    'rules/workflow.json',
    'scripts/solo-native-attachment.mjs',
  ])
    assert.equal(repairPathAllowed(p), false, p);
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/a.mjs'), 'before');
  const proposal = {
    action: 'patch',
    reason: 'fixture',
    files: [
      { path: 'lib/a.mjs', beforeSha256: digest('wrong'), content: 'after' },
      { path: 'tests/a.test.mjs', beforeSha256: null, content: 'test' },
    ],
    tests: ['tests/a.test.mjs'],
  };
  assert.throws(() => validateRepair(dir, proposal), /基线/);
  proposal.files[0].beforeSha256 = digest('before');
  assert.equal(validateRepair(dir, proposal), true);
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'existing assertions');
  proposal.files[1].beforeSha256 = digest('existing assertions');
  proposal.files[1].content = 'existing assertions plus regression';
  assert.equal(validateRepair(dir, proposal), true);
  proposal.files[1].content = 'existing assertions';
  assert.throws(() => validateRepair(dir, proposal), /回归测试/);
});
// Patch verification runs the state tests, not a recursive repair worker/sandbox.
for (const mode of ['repair', 'escalation'])
  test(
    `${mode} worker consumes structured Codex output, proves red/green and commits only the isolated tree`,
    { skip: process.env.SELF_HEAL_TEST === '1' },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-worker-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const root = path.join(dir, 'repo');
      fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.writeFileSync(
        path.join(root, '.gitignore'),
        '.runner/\nnode_modules\n',
      );
      const before = 'export const value = 0;\n';
      fs.writeFileSync(path.join(root, 'lib/value.mjs'), before);
      command('git', ['init', '-b', 'main'], root);
      command('git', ['config', 'user.email', 'fixture@example.test'], root);
      command('git', ['config', 'user.name', 'Fixture'], root);
      command('git', ['add', '.'], root);
      command('git', ['commit', '-m', 'fixture'], root);
      const base = command('git', ['rev-parse', 'HEAD'], root),
        id = 'test-repair',
        jobDir = path.join(root, '.runner/self-heal/jobs', id),
        jobFile = path.join(jobDir, 'job.json');
      const proposal = {
        action: 'patch',
        reason: 'value incorrect',
        files: [
          {
            path: 'lib/value.mjs',
            beforeSha256: digest(before),
            content: 'export const value = 1;\n',
          },
          {
            path: 'tests/value.test.mjs',
            beforeSha256: null,
            content:
              "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../lib/value.mjs';test('value',()=>assert.equal(value,1));\n",
          },
        ],
        tests: ['tests/value.test.mjs'],
      };
      saveJSON(jobFile, { id, root, mode, state: 'running' });
      saveJSON(path.join(jobDir, 'context.json'), {
        reason: 'value incorrect',
        previousDiagnoses: [
          { id: 'previous-rejected', reason: 'missed root cause' },
        ],
      });
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      const fake = `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const last=a[a.indexOf('--output-last-message')+1];fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))},JSON.stringify(a)+'\\n');let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{fs.writeFileSync(last,JSON.stringify(last.includes('maintenance-review')?{approved:true,reason:'fixture'}:${JSON.stringify(proposal)}));process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture-session'})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');});`;
      fs.writeFileSync(path.join(bin, 'codex'), fake, { mode: 0o700 });
      const old = process.env.PATH;
      process.env.PATH = bin + path.delimiter + old;
      t.after(() => {
        process.env.PATH = old;
      });
      const result = await repairJob(jobFile);
      assert.equal(result.state, 'ready', result.reason);
      assert.equal(result.action, 'publish');
      assert.equal(command('git', ['rev-parse', 'HEAD'], root), base);
      assert.equal(
        fs.readFileSync(path.join(root, 'lib/value.mjs'), 'utf8'),
        before,
      );
      assert.match(
        fs.readFileSync(path.join(jobDir, 'test-before.log'), 'utf8'),
        /not ok/,
      );
      assert.match(
        fs.readFileSync(path.join(jobDir, 'test-after.log'), 'utf8'),
        /ok 1/,
      );
      const calls = fs
        .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(calls.length, 2);
      assert.ok(
        calls[0].some((arg) =>
          arg.includes(
            mode === 'escalation'
              ? 'maintenance-escalation'
              : 'maintenance-fix',
          ),
        ),
      );
      assert.ok(calls[1].some((arg) => arg.includes('maintenance-review')));
      for (const args of calls) {
        assert.ok(args.includes('read-only'));
        assert.ok(args.includes('--output-schema'));
        assert.ok(!args.includes('--model'));
      }
      assert.equal((await repairJob(jobFile)).commit, result.commit);
      assert.equal(
        fs
          .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n').length,
        2,
      );
    },
  );
