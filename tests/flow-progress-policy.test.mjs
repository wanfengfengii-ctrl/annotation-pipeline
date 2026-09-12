import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runCodexProcess } from '../scripts/codex-process.mjs';
import { runRuntimeProcess } from '../scripts/runtime-process.mjs';
import { retryCount, retryBudgets } from '../lib/retry-policy.mjs';
import { postprocessRetryDue } from '../lib/project-recovery.mjs';
import { patrolHealth } from '../lib/patrol-health.mjs';
import {
  supplyFailure,
  wordingRepairAllowed,
} from '../scripts/supply-recovery.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-progress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('productive verification exceeds the old ceiling; large and split UTF-8 logs stay exact', async (t) => {
  const dir = fixture(t),
    file = path.join(dir, 'full.log');
  const r = await runRuntimeProcess(
    process.execPath,
    [
      '-e',
      "let i=0;const t=setInterval(()=>{console.log(++i);if(i===6){clearInterval(t);process.stdout.write('中'.repeat(900000));}},80)",
    ],
    { timeoutSeconds: 0.3, maxTimeoutSeconds: 0.35, logPath: file },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.limited, false);
  assert.equal(r.outputTruncated, true);
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 2 * 1024 * 1024);
  assert.equal(r.logSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(r.output.length < 2 * 1024 * 1024);
  assert.ok(r.elapsedSeconds > 0.35);
  const small = await runRuntimeProcess(
    process.execPath,
    [
      '-e',
      "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),40)",
    ],
    { timeoutSeconds: 1, logPath: path.join(dir, 'small.log') },
  );
  assert.equal(small.output, '中文');
});
test('Codex resumes only its exact interrupted stage and leaves previous trace bytes intact', async (t) => {
  const dir = fixture(t),
    bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(dir, 'args.jsonl'))},JSON.stringify(args)+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'same-session'}));
if(args.includes('resume')){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{}');console.log(JSON.stringify({type:'turn.completed'}));}
else {console.log(JSON.stringify({type:'item.completed',item:{id:'a',type:'reasoning',text:'已读取入口'}}));setInterval(()=>process.stderr.write('heartbeat\\n'),30);}
`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = bin + path.delimiter + before;
  t.after(() => {
    process.env.PATH = before;
  });
  const opts = {
    stage: 'score',
    prompt: '相同原题和证据',
    contract: { type: 'object' },
    cwd: dir,
    dir,
    turnId: 'turn.attempt-1',
    idleMs: 300,
    stopGraceMs: 30,
  };
  await assert.rejects(runCodexProcess(opts), /无有效进展/);
  const file = path.join(dir, 'turn.attempt-1.score.events.jsonl'),
    original = fs.readFileSync(file);
  const result = await runCodexProcess({ ...opts, turnId: 'turn.attempt-2' });
  assert.equal(result.resumeReceipt.threadId, 'same-session');
  assert.equal(result.resumeReceipt.resumeCount, 1);
  assert.deepEqual(fs.readFileSync(file), original);
  const args = fs
    .readFileSync(path.join(dir, 'args.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(args[1].slice(0, 3), ['exec', 'resume', 'same-session']);
  assert.ok(!args[1].includes('--last'));
  // Changed evidence must start another stage, even when the turn ID matches.
  await assert.rejects(
    runCodexProcess({ ...opts, prompt: '证据已经变更' }),
    /无有效进展/,
  );
  const calls = fs
    .readFileSync(path.join(dir, 'args.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.ok(!calls[2].includes('resume'));
});
test('retry budgets are scoped by cause and deployed fix, while native evidence gates remain', () => {
  const record = { attempts: 20 },
    context = { stage: 'score', error: '引用证据为空', revision: 'fix1' };
  for (let i = 0; i < 2; i++)
    record.retryBudgets = retryBudgets(record, context);
  assert.equal(retryCount(record, context), 2);
  assert.equal(retryCount(record, { ...context, error: '网关 504' }), 0);
  assert.equal(retryCount(record, { ...context, revision: 'fix2' }), 0);
  const turn = {
    id: 'r',
    status: 'failed',
    stage: 'score',
    error: context.error,
    stageRecovery: record,
    executionOutcome: 'complete',
    traceExport: { verified: true },
    permissionAudit: { passed: true },
  };
  const task = { projectSeries: {}, turns: [turn] };
  assert.equal(
    postprocessRetryDue(task, { autoContinue: true, recoveryRevision: 'fix1' }),
    false,
  );
  assert.equal(
    postprocessRetryDue(task, { autoContinue: true, recoveryRevision: 'fix2' }),
    true,
  );
  turn.permissionAudit.passed = false;
  assert.equal(
    postprocessRetryDue(task, { autoContinue: true, recoveryRevision: 'fix2' }),
    false,
  );
});
test('patrol catches a stalled running stage and sustained empty slots without killing work', () => {
  const now = Date.now(),
    task = {
      id: 't',
      title: '项目',
      projectSeries: {},
      turns: [{ id: 'r', status: 'running', stage: 'score' }],
    },
    config = { enabled: true, autoContinue: true, concurrency: 3 },
    runner = { scheduler: { active: 1, effective: 3 } };
  const progress = {
    't:r': {
      lastProgressAt: new Date(now - 16 * 60000).toISOString(),
      idleLimitMs: 15 * 60000,
    },
  };
  const health = patrolHealth({ tasks: [task], config, runner, progress, now });
  assert.equal(health.needsAction, true);
  assert.equal(health.incidents[0].state, 'stalled_running');
  progress['t:r'].lastProgressAt = new Date(now - 60000).toISOString();
  assert.equal(
    patrolHealth({ tasks: [task], config, runner, progress, now }).needsAction,
    false,
  );
  const queued = {
    id: 'q',
    title: '待续题',
    projectSeries: {},
    turns: [{ id: 'qr', status: 'queued' }],
  };
  const first = patrolHealth({
    tasks: [task, queued],
    config,
    runner,
    progress,
    now,
  });
  assert.equal(
    patrolHealth({
      tasks: [task, queued],
      config,
      runner,
      progress,
      previous: first,
      now: now + 16 * 60000,
    }).underutilized,
    true,
  );
});
test('supply preserves drafts, uses short transport retries, and pauses only authentication', () => {
  const state = {
    draft: { requestId: 'retained', generated: { value: { prompt: '原题' } } },
  };
  for (let i = 0; i < 10; i++)
    supplyFailure(state, Error('网关 504'), 1000, 'auth1');
  assert.equal(state.draft.requestId, 'retained');
  assert.equal(state.nextAt, 301000);
  supplyFailure(state, Error('认证失败 401'), 1000, 'auth1');
  assert.equal(state.authPause.credentialsRevision, 'auth1');
  assert.equal(
    wordingRepairAllowed(
      {
        value: {
          questionCompliant: false,
          matchedRuleIds: ['forbidden'],
          duplicateTaskIds: [],
        },
      },
      {},
    ),
    false,
  );
});

test('supply authentication failure remains actionable even before any project exists', () => {
  const health = patrolHealth({
    tasks: [],
    config: { enabled: true, autoContinue: true, concurrency: 3 },
    runner: {
      scheduler: {
        active: 0,
        effective: 3,
        supplyFailure: { kind: 'authentication', attempts: 1 },
      },
    },
  });
  assert.equal(health.needsAction, true);
  assert.equal(health.status, 'supply_blocked');
});
