import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileSelfHeal,
  nextSelfHealAction,
  selfHealDefaults,
  recoveryAction,
  digest,
} from '../lib/self-heal.mjs';
import { repairPathAllowed, validateRepair } from '../lib/self-heal-patch.mjs';
import { repairJob, runCheck } from '../scripts/self-heal-repair.mjs';
import { command, saveJSON } from '../scripts/self-heal-io.mjs';
import {
  advanceRelease,
  prepareBuildDependencies,
} from '../scripts/self-heal-release.mjs';
import { identity } from '../scripts/recovery.mjs';

const at = Date.parse('2026-09-12T02:00:00Z');
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
test('published updates wait for the exact old runner without an elapsed-time kill', async (t) => {
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
});
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
    reconcileSelfHeal(b, s, at + 21 * 60000).incidents[i.id].state,
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
test('daily and per-fault budgets persist across controller restart', () => {
  const s = snapshot(),
    b = ready(s),
    i = Object.values(b.incidents)[0];
  i.attempts = selfHealDefaults.maxAttempts;
  assert.equal(
    nextSelfHealAction(JSON.parse(JSON.stringify(b)), s, at + 61000),
    null,
  );
  i.attempts = 0;
  b.jobs = Array.from({ length: 6 }, () => ({
    startedAt: new Date(at).toISOString(),
    state: 'failed',
  }));
  assert.equal(nextSelfHealAction(b, s, at + 61000), null);
});
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
});
// Patch verification runs the state tests, not a recursive repair worker/sandbox.
test(
  'real worker consumes structured Codex output, proves red/green and commits only the isolated tree',
  { skip: process.env.SELF_HEAL_TEST === '1' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-heal-worker-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const root = path.join(dir, 'repo');
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.runner/\nnode_modules\n');
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
    saveJSON(jobFile, { id, root, state: 'running' });
    saveJSON(path.join(jobDir, 'context.json'), { reason: 'value incorrect' });
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
    for (const args of calls) {
      assert.ok(args.includes('read-only'));
      assert.ok(args.includes('--output-schema'));
      assert.ok(!args.includes('--model'));
    }
    assert.equal((await repairJob(jobFile)).commit, result.commit);
    assert.equal(
      fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n')
        .length,
      2,
    );
  },
);
