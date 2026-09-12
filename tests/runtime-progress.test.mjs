import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRuntimeProcess } from '../scripts/runtime-process.mjs';
import {
  executeRuntimeCases,
  blockedRuntimeAttempts,
} from '../scripts/runtime-case-execution.mjs';
import {
  saveRuntimePlan,
  readRuntimePlan,
  applyRuntimeStepRepair,
} from '../scripts/runtime-plan-checkpoint.mjs';
import { runtimeSettings } from '../scripts/runtime-settings.mjs';
import {
  runtimeRecoveryCandidate,
  runtimeRecoveryEligible,
  runtimeRecoveryDue,
  runtimeRecoveryLabel,
} from '../lib/runtime-recovery.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const spec = (id, command) => ({
  id,
  kind: 'acceptance',
  command,
  codeEvidence: 'app.js:1',
  requirement: id,
  expected: id,
  timeoutSeconds: 2,
});
const limits = {
  totalTimeoutSeconds: 60,
  stepTimeoutSeconds: 10,
  maxChecks: 64,
};
test('real output extends soft timeout; noise remains bounded, saved logs are original', async (t) => {
  const dir = fixture(t),
    file = path.join(dir, 'progress.log');
  const success = await runRuntimeProcess(
    process.execPath,
    [
      '-e',
      'let i=0;const t=setInterval(()=>{console.log(++i);if(i===5)clearInterval(t)},70)',
    ],
    { timeoutSeconds: 0.15, maxTimeoutSeconds: 0.9, logPath: file },
  );
  assert.equal(success.exitCode, 0);
  assert.equal(success.timedOut, false);
  assert.ok(success.extensions >= 1);
  assert.equal(fs.readFileSync(file, 'utf8'), success.output);
  const stopped = await runRuntimeProcess(
    process.execPath,
    ['-e', "setInterval(()=>console.log('still working'),40)"],
    {
      timeoutSeconds: 0.15,
      maxTimeoutSeconds: 0.4,
      logPath: path.join(dir, 'paused.log'),
    },
  );
  assert.equal(stopped.timedOut, true);
  assert.equal(stopped.producedOutput, true);
  assert.ok(stopped.elapsedSeconds < 2);
  const silent = await runRuntimeProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { timeoutSeconds: 0.1, maxTimeoutSeconds: 1 },
  );
  assert.equal(silent.producedOutput, false);
  assert.equal(silent.extensions, 0);
});
test('same question resumes only failed case; changed code, question or logs require actual execution', async (t) => {
  const dir = fixture(t),
    counts = path.join(dir, 'counts.txt'),
    seen = [],
    progress = [];
  const context = {
    taskId: path.basename(dir),
    turnId: 'turn',
    imageId: 'image',
    source: { files: ['sha1'] },
    prompt: 'prompt',
    acceptance: ['a'],
    helperSha256: 'helper',
  };
  const first = spec(
    'first',
    `require('node:fs').appendFileSync(${JSON.stringify(counts)},'first\\n');console.log('actual first result')`,
  );
  const failed = spec(
    'second',
    "console.log('actual dependency missing');process.exit(2)",
  );
  const run = async (plan, ctx = context, retryContext = null) => {
    const root = fs.mkdtempSync(path.join(dir, 'execution-'));
    return executeRuntimeCases({
      plan,
      context: ctx,
      dir,
      root,
      limits,
      retryContext,
      openCase: async (c) => {
        seen.push(c.id);
        return {};
      },
      closeCase: async () => {},
      execute: async (_h, c, options) => ({
        ...(await runRuntimeProcess(
          process.execPath,
          ['-e', c.command],
          options,
        )),
        sourceChanged: false,
      }),
      onProgress: (value) => progress.push(value),
    });
  };
  const initial = await run({ checks: [first, failed] });
  assert.deepEqual(initial.progress.remainingIds, ['second']);
  assert.deepEqual(initial.progress.completedIds, ['first']);
  const corrected = {
    ...failed,
    command: "console.log('actual dependency ready and assertion passed')",
  };
  const recovered = await run({ checks: [first, corrected] }, context, {
    checks: [{ id: 'second', outcome: 'blocked' }],
  });
  assert.deepEqual(recovered.progress.reusedIds, ['first']);
  assert.deepEqual(seen, ['first', 'second', 'second']);
  assert.equal(fs.readFileSync(counts, 'utf8'), 'first\n');
  assert.ok(recovered.runs[0].reusedFrom);
  assert.equal(
    fs.readFileSync(initial.runs[1].logPath, 'utf8'),
    'actual dependency missing\n',
  );
  const changed = await run(
    { checks: [first, corrected] },
    { ...context, source: { files: ['sha2'] } },
  );
  assert.deepEqual(changed.progress.reusedIds, []);
  const nextQuestion = await run(
    { checks: [first, corrected] },
    { ...context, turnId: 'new-turn' },
  );
  assert.deepEqual(nextQuestion.progress.reusedIds, []);
  fs.appendFileSync(initial.runs[0].logPath, 'changed');
  const tampered = await run({ checks: [first, corrected] });
  assert.ok(!tampered.progress.reusedIds.includes('first'));
  assert.ok(progress.every((p) => fs.existsSync(p.path)));
});
test('setup and command changes invalidate dependent execution; timeout cannot become a cached pass', async (t) => {
  const dir = fixture(t);
  let execution = 0;
  const context = { taskId: 'task', turnId: 'turn', source: 'same' };
  const setup = { ...spec('setup', "console.log('setup')"), kind: 'setup' },
    check = spec('business', "console.log('result')");
  const run = async (plan, forceTimeout = false) =>
    executeRuntimeCases({
      plan,
      context,
      dir,
      root: fs.mkdtempSync(path.join(dir, 'attempt-')),
      limits,
      openCase: async () => ({}),
      closeCase: async () => {},
      execute: async (_h, c, options) => {
        execution++;
        const r = await runRuntimeProcess(
          process.execPath,
          ['-e', c.command],
          options,
        );
        return {
          ...r,
          sourceChanged: false,
          ...(forceTimeout && c.id === 'business'
            ? { timedOut: true, exitCode: null }
            : {}),
        };
      },
    });
  await run({ checks: [setup, check] });
  execution = 0;
  await run({
    checks: [{ ...setup, command: "console.log('changed setup')" }, check],
  });
  assert.equal(execution, 2);
  const timeoutCheck = { ...check, command: "console.log('partial')" };
  execution = 0;
  const timed = await run({ checks: [setup, timeoutCheck] }, true);
  assert.equal(
    execution,
    2,
    'a timeout must not run the same setup and command again',
  );
  const blocked = blockedRuntimeAttempts(dir, context, {
    checks: [setup, timeoutCheck],
  });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, 'business');
  assert.ok(blocked[0].logRefs.length > 0);
  assert.equal(timed.progress.completedIds.length, 0);
  execution = 0;
  await run({ checks: [setup, timeoutCheck] });
  assert.equal(execution, 2);
});
test('plan checkpoint and local step correction preserve completed scripts and original trace', (t) => {
  const dir = fixture(t),
    tracePath = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(tracePath, '{}\n');
  const identity = { turnId: 'a', source: 'sha1' },
    plan = {
      tracePath,
      value: {
        summary: 'plan',
        limits,
        checks: [spec('first', 'echo first'), spec('second', 'echo wrong')],
      },
    };
  const receipt = saveRuntimePlan(dir, identity, plan);
  assert.deepEqual(readRuntimePlan(receipt, dir, identity), plan);
  assert.equal(
    readRuntimePlan(receipt, dir, { ...identity, source: 'new' }),
    null,
  );
  const patched = applyRuntimeStepRepair(
    { plan, ids: ['second'] },
    {
      summary: 'fix check',
      replace: [
        {
          reason: 'actual locator changed',
          check: { ...plan.value.checks[1], command: 'echo correct' },
        },
      ],
    },
  );
  assert.deepEqual(patched.checks[0], plan.value.checks[0]);
  assert.equal(patched.checks[1].id, 'second');
  assert.throws(
    () =>
      applyRuntimeStepRepair(
        { plan, ids: ['second'] },
        {
          summary: 'bad',
          replace: [
            {
              reason: 'skip',
              check: { ...plan.value.checks[0], command: 'true' },
            },
          ],
        },
      ),
    /不能改动/,
  );
  fs.appendFileSync(tracePath, 'changed');
  assert.equal(readRuntimePlan(receipt, dir, identity), null);
});
test('productive timeout queues same question; repeated no-progress pauses without failure or extra Claude calls', (t) => {
  const dir = fixture(t);
  fs.writeFileSync(
    path.join(dir, 'runtime-verification-settings.json'),
    JSON.stringify({ totalTimeoutSeconds: 2400, stepTimeoutSeconds: 900 }),
  );
  assert.equal(runtimeSettings(dir).totalTimeoutSeconds, 2400);
  const plan = { path: '/evidence/plan', sha256: 'a'.repeat(64) };
  const base = {
    id: 'turn',
    stage: 'runtime-running',
    executionOutcome: 'complete',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
    promptId: 'original-prompt',
    sessionId: 'session',
    status: 'queued',
  };
  let previous;
  for (let i = 0; i < 4; i++) {
    const r = runtimeRecoveryCandidate({
      previous,
      plan,
      progress: { completedIds: ['first'], producedOutput: true },
      stage: base.stage,
      turnId: base.id,
      now: 1000,
      error: 'timeout',
    });
    const turn = { ...base, automation: { runtimeRecovery: r } };
    assert.ok(runtimeRecoveryEligible(turn));
    assert.equal(runtimeRecoveryDue(turn, 1000), false);
    if (i === 0) {
      assert.equal(r.stalledAttempts, 0);
      assert.equal(runtimeRecoveryDue(turn, 999999), true);
    }
    if (i === 3) {
      assert.equal(r.state, 'paused');
      assert.equal(runtimeRecoveryDue(turn, 999999), false);
      assert.equal(runtimeRecoveryLabel(turn), '验收待处理');
    }
    previous = r;
  }
  assert.equal(
    runtimeRecoveryCandidate({ plan, stage: 'claude', turnId: 'turn' }),
    null,
  );
  const preparing = runtimeRecoveryCandidate({
    product: plan,
    stage: 'runtime-plan',
    turnId: 'turn',
    error: 'plan timed out',
  });
  assert.ok(
    runtimeRecoveryEligible({
      ...base,
      stage: 'runtime-plan',
      automation: { runtimeRecovery: preparing },
    }),
  );
  assert.equal(
    runtimeRecoveryEligible({
      ...base,
      executionOutcome: 'error',
      automation: { runtimeRecovery: previous },
    }),
    false,
  );
});
