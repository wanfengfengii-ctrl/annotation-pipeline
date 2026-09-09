import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateRuntimePlan,
  runtimeRepairEvidence,
  runtimeVersion,
} from '../lib/runtime-verification.mjs';
import {
  copyVerificationSource,
  finalizeRuntimeReport,
} from '../scripts/runtime-verification.mjs';
const spec = {
  id: 'api',
  kind: 'acceptance',
  command: 'python3 /tmp/check.py',
  expected: 'total=4',
  requirement: '计算总数',
  codeEvidence: 'app.py:1',
  timeoutSeconds: 10,
};
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('Runtime plans require real acceptance, unique IDs and bounded execution', () => {
  assert.equal(
    validateRuntimePlan({ summary: 'check', checks: [spec] }).checks.length,
    1,
  );
  for (const checks of [
    [],
    [spec, spec],
    [{ ...spec, kind: 'setup' }],
    [{ ...spec, timeoutSeconds: 301 }],
    Array.from({ length: 8 }, (_, i) => ({
      ...spec,
      id: 'c' + i,
      timeoutSeconds: 300,
    })),
  ])
    assert.throws(() => validateRuntimePlan({ summary: 'check', checks }));
});
test('Verification copy omits secrets and symlinks and never edits original', (t) => {
  const dir = fixture(t),
    src = path.join(dir, 'source'),
    dest = path.join(dir, 'copy');
  mkdirSync(src);
  writeFileSync(path.join(src, 'app.py'), 'print(1)');
  writeFileSync(path.join(src, '.env'), 'SECRET');
  symlinkSync('/etc/passwd', path.join(src, 'escape'));
  const m = copyVerificationSource(src, dest);
  assert.equal(m.files.length, 1);
  assert(!existsSync(path.join(dest, '.env')));
  assert(!existsSync(path.join(dest, 'escape')));
  writeFileSync(path.join(dest, 'app.py'), 'print(2)');
  assert.equal(readFileSync(path.join(src, 'app.py'), 'utf8'), 'print(1)');
});
test('Diagnosis requires real failed assertions and valid immutable logs', (t) => {
  const dir = fixture(t),
    logPath = path.join(dir, 'api.log'),
    output = 'expected=4 actual=3\nAssertionError\n';
  writeFileSync(logPath, output);
  const plan = { summary: 'check', checks: [spec] },
    run = {
      id: 'api',
      exitCode: 1,
      timedOut: false,
      sourceChanged: false,
      limited: false,
      logPath,
      logSha256: createHash('sha256').update(output).digest('hex'),
    };
  const verdict = {
    summary: 'wrong result',
    checks: [
      {
        id: 'api',
        outcome: 'reproduced',
        observed: '3 instead of 4',
        evidenceLine: 1,
      },
    ],
  };
  const r = finalizeRuntimeReport(plan, [run], verdict);
  assert.equal(r.status, 'bugs');
  assert(
    runtimeRepairEvidence({
      automation: {
        runtimeVerification: {
          ...r,
          reportPath: '/report',
          reportSha256: 'hash',
        },
      },
    }),
  );
  for (const patch of [
    { exitCode: 0 },
    { exitCode: 2 },
    { timedOut: true },
    { sourceChanged: true },
    { limited: true },
    { exitCode: null },
  ])
    assert.throws(() =>
      finalizeRuntimeReport(plan, [{ ...run, ...patch }], verdict),
    );
  assert.throws(() =>
    finalizeRuntimeReport(plan, [run], {
      ...verdict,
      checks: [{ ...verdict.checks[0], id: 'invented' }],
    }),
  );
  assert.throws(() =>
    finalizeRuntimeReport(plan, [run], {
      ...verdict,
      checks: [{ ...verdict.checks[0], evidenceLine: 99 }],
    }),
  );
  const blocked = finalizeRuntimeReport(plan, [{ ...run, timedOut: true }], {
    ...verdict,
    checks: [{ ...verdict.checks[0], outcome: 'blocked' }],
  });
  assert.equal(blocked.status, 'blocked');
  assert(
    !runtimeRepairEvidence({
      automation: {
        runtimeVerification: {
          ...blocked,
          reportPath: '/report',
          reportSha256: 'hash',
        },
      },
    }),
  );
  writeFileSync(logPath, 'changed');
  assert.throws(() => finalizeRuntimeReport(plan, [run], verdict));
});
test('Passed checks and unconfirmed static suspicions cannot create Bug tasks', (t) => {
  const dir = fixture(t),
    logPath = path.join(dir, 'api.log');
  writeFileSync(logPath, 'OK');
  const run = {
    id: 'api',
    exitCode: 0,
    timedOut: false,
    logPath,
    logSha256: createHash('sha256').update('OK').digest('hex'),
  };
  for (const outcome of ['passed', 'not_reproduced']) {
    const r = finalizeRuntimeReport(
      { summary: 'check', checks: [spec] },
      [run],
      {
        summary: 'ok',
        checks: [{ id: 'api', outcome, observed: 'OK', evidenceLine: 1 }],
      },
    );
    assert.equal(r.status, 'passed');
    assert(
      !runtimeRepairEvidence({
        automation: { runtimeVerification: { ...r, version: runtimeVersion } },
      }),
    );
  }
});

test('Automatic follow-up binds a Bug to reproduced checks and prioritizes repair', async () => {
  const { repairDecision } = await import('../lib/project-series.mjs');
  const { nextDecision } = await import('../lib/workflow.mjs');
  const turn = {
    id: 'a',
    questionRootId: 'a',
    status: 'review',
    category: '0-1 代码生成',
    difficulty: '中等',
    claudeAttempts: ['one'],
    prompt: '原题',
    automation: {
      runtimeVersion,
      runtimeVerification: {
        version: runtimeVersion,
        executed: true,
        status: 'bugs',
        reportPath: '/report',
        reportSha256: 'hash',
        checks: [
          {
            id: 'api',
            kind: 'acceptance',
            exitCode: 1,
            timedOut: false,
            outcome: 'reproduced',
            logPath: '/log',
            logSha256: 'hash',
            requirement: '计算结果正确',
            codeEvidence: 'app.py:1',
          },
        ],
      },
    },
  };
  const task = { turns: [turn] },
    decision = {
      action: 'repair',
      prompt: '计算结果少了一，把这个问题修好',
      reason: '独立检查已复现',
      repairCheckIds: ['api'],
    };
  assert.equal(repairDecision(task, turn, decision).repairOf, 'a');
  assert.throws(
    () =>
      repairDecision(task, turn, { ...decision, repairCheckIds: ['invented'] }),
    /检查 ID/,
  );
  turn.automation.next = {
    value: { action: 'complete', prompt: '无', reason: 'done' },
  };
  assert.throws(
    () => nextDecision(task, turn, { autoContinue: true }),
    /必须先/,
  );
  turn.automation.runtimeVerification.status = 'passed';
  assert.throws(() => repairDecision(task, turn, decision), /复现证据/);
});
