import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { applyScorePatch, scoreWritingFields } from '../lib/score-patch.mjs';
import { taskTiming } from '../lib/task-timing.mjs';
import { summarizeTiming, timingVersion } from '../scripts/attempt-timing.mjs';
import { latestRequest } from '../lib/latest-request.mjs';
import { deliveryIndex } from '../lib/delivery-index.mjs';
import { soloStatusSnapshot } from '../lib/solo-upload-status.mjs';
import { applyBatchRecovery, batchRevision } from '../lib/upload-batches.mjs';
import {
  dueUpload,
  claimUpload,
  resumePlan,
} from '../scripts/solo-schedule.mjs';
import {
  candidateFeedback,
  projectCapabilities,
} from '../lib/supply-feedback.mjs';
import { codexStage } from '../scripts/codex-stages.mjs';
const temp = (t) => {
  const p = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'console-opt-')));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
};
const at = (s) => new Date(s * 1000).toISOString();

test('score patch rejects widening, duplicates and immutable fields', () => {
  const value = {
    scores: [5, 4, 3, 2, 1],
    descriptions: ['a', 'b', 'c', 'd', 'e'],
    evidenceRefs: ['1', '2', '3', '4', '5'],
  };
  const base = { value, fields: ['descriptions[1]'] };
  assert.deepEqual(
    applyScorePatch(base, {
      patches: [{ field: 'descriptions[1]', value: '新描述' }],
    }),
    { ...value, descriptions: ['a', '新描述', 'c', 'd', 'e'] },
  );
  assert.equal(value.descriptions[1], 'b');
  for (const patch of [
    { patches: [{ field: 'scores[1]', value: '5' }] },
    { patches: [{ field: 'descriptions[0]', value: 'x' }] },
    { patches: [], scores: [] },
    { patches: Array(2).fill({ field: 'descriptions[1]', value: 'x' }) },
  ])
    assert.throws(() => applyScorePatch(base, patch));
  assert.deepEqual(
    scoreWritingFields([
      'descriptions[1]：问题',
      'other：问题',
      'descriptions[1]：其他',
    ]),
    ['descriptions[1]', 'other'],
  );
});
test('timing joins real spans, retains running work and counts overlap only once', (t) => {
  const file = path.join(temp(t), 'timing');
  const events = [
    { event: 'attempt-start', at: at(0) },
    { event: 'stage-queued', spanId: 'a', stage: 'score', at: at(0) },
    {
      event: 'stage-start',
      spanId: 'a',
      stage: 'score',
      at: at(10),
      queueMs: 10000,
    },
    {
      event: 'stage-end',
      spanId: 'a',
      stage: 'score',
      at: at(30),
      elapsedMs: 20000,
      outcome: 'failed',
    },
    { event: 'attempt-end', at: at(30), elapsedMs: 30000, outcome: 'failed' },
  ].map((e) => ({ version: timingVersion, attemptId: 'one', ...e }));
  writeFileSync(file, events.map(JSON.stringify).join('\n'));
  const attempts = summarizeTiming(file);
  attempts.push({
    attemptId: 'two',
    startedAt: at(25),
    stages: [
      {
        stage: 'score',
        queuedAt: at(25),
        startedAt: at(25),
        queueMs: 0,
        finishedAt: at(40),
        elapsedMs: 15000,
      },
    ],
  });
  const result = taskTiming(attempts, at(40), at(50));
  assert.equal(result.wallMs, 40000);
  assert.equal(result.activeMs, 30000);
  assert.equal(result.queueMs, 10000);
  assert.equal(result.repeatedStages, 1);
  assert.equal(result.unaccountedMs, 0);
  assert.equal(taskTiming([], null, at(50)).wallMs, null);
});
test('old HTTP responses cannot overwrite a newer selection or the following poll', async (t) => {
  let release;
  const received = new Promise((resolve) => {
    release = resolve;
  });
  let first;
  const server = createServer((req, res) => {
    if (req.url === '/1') {
      first = res;
      release();
    } else res.end('{"page":2}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    requests = latestRequest();
  let page;
  const load = async (n) => {
    const current = requests.begin();
    const data = await (await fetch(base + '/' + n)).json();
    if (current()) page = data.page;
  };
  const old = load(1);
  await received;
  requests.invalidate();
  await load(2);
  first.end('{"page":1}');
  await old;
  await load(2);
  assert.equal(page, 2);
});
test('delivery keeps original message UUID distinct from platform PromptID and counts export batches', () => {
  const turn = {
    id: 'turn',
    prompt: '原题',
    sessionId: 'session',
    promptId: 'message',
    automation: {},
  };
  const task = { id: 'task', turns: [turn] };
  const d = deliveryIndex(task, turn, {
    exports: [
      { turnId: 'turn', batchId: 'batch' },
      { turnId: 'turn', batchId: 'batch' },
    ],
    uploads: {
      'task:turn': {
        identity: {
          sessionId: 'session',
          messageUuid: 'message',
          promptId: 'native',
        },
      },
    },
  });
  assert.equal(d.nativePromptId, 'native');
  assert.equal(d.messageUuid, 'message');
  assert.equal(d.exportCount, 1);
  assert.equal(d.finalTrace, null);
  assert.equal(deliveryIndex(task, turn).nativePromptId, null);
});
test('uncertain receipts remain uncertain and batch recovery preserves fixed members and window', () => {
  const now = new Date('2026-09-12T10:00:00+08:00'),
    slot = now.toISOString();
  const member = {
    key: 'task:turn',
    sourceDigest: 'a'.repeat(64),
    packetDigest: 'b'.repeat(64),
  };
  const run = { status: 'blocked', members: [member], attempts: [] },
    state = { runs: { [slot]: run } };
  const ledger = {
    entries: {
      'task:turn': {
        remoteId: 4,
        remoteStatus: 'QC_PASSED',
        state: 'submitting',
        updatedAt: now.toISOString(),
      },
    },
  };
  assert.equal(
    soloStatusSnapshot(ledger, { entries: {} }, now.toISOString(), state)
      .entries['task:turn'].status,
    'uncertain',
  );
  assert.equal(
    applyBatchRecovery(state, { slot, revision: 'old' }, now),
    false,
  );
  assert.equal(
    applyBatchRecovery(state, { slot, revision: batchRevision(run) }, now),
    true,
  );
  assert.equal(dueUpload(now, state).slot, slot);
  assert.equal(
    dueUpload(new Date('2026-09-13T01:00:00+08:00'), state).due,
    false,
  );
  assert.equal(claimUpload(state, { now }).claimed, false); // no actual login
  assert.deepEqual(run.members, [member]);
  const plan = resumePlan(run, { packets: [], blocked: [] }, ledger);
  assert.equal(plan.settled.length, 0);
  assert.equal(plan.packets[0].state, 'uncertain');
});
test('candidate feedback and capability summary distinguish unverified and reproduced issues', () => {
  const feedback = candidateFeedback({
    rejectedDrafts: [
      { generated: { value: { prompt: '重复草稿' } }, reason: '实质雷同' },
    ],
  });
  assert.equal(feedback[0].kind, 'policy');
  assert.equal(projectCapabilities({ turns: [{ automation: {} }] }), null);
  const summary = projectCapabilities({
    id: 't',
    turns: [
      {
        id: 'r',
        automation: {
          runtimeVerification: {
            reportSha256: 'a'.repeat(64),
            checks: [
              {
                id: 'bug',
                kind: 'acceptance',
                outcome: 'reproduced',
                requirement: '实际问题',
              },
            ],
          },
        },
      },
    ],
  });
  assert.equal(summary.checks[0].outcome, 'reproduced');
  assert.match(summary.note, /不能将静态检查/);
});
test('score checkpoint resumes completed native stage and invalidates changed inputs', async (t) => {
  const dir = temp(t),
    oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  writeFileSync(path.join(dir, 'evidence.log'), '已完成操作\n');
  const value = {
    scores: Array(5).fill(5),
    descriptions: Array(5).fill('完成了保存和读取，结果与要求一致。'),
    other: '无',
    when: Array(5).fill('保存时'),
    behavior: Array(5).fill('读取记录'),
    impact: Array(5).fill('完成操作'),
    expected: Array(5).fill('结果一致'),
    evidenceRefs: Array(5).fill('evidence.log:1'),
    processFindings: '操作有对应记录。',
    artifactFindings: '保存和读取结果一致。',
  };
  writeFileSync(
    path.join(dir, 'codex'),
    `#!/usr/bin/env node\nconst fs=require('fs'),args=process.argv.slice(2); process.stdin.resume();process.stdin.on('end',()=>{const out=args[args.indexOf('--output-last-message')+1],v=${JSON.stringify(value)};fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))},'call\\n');fs.writeFileSync(out,JSON.stringify(v));for(const e of [{type:'thread.started',thread_id:'fake-thread'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(v)}},{type:'turn.completed'}])console.log(JSON.stringify(e));});`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + path.delimiter + oldPath;
  const run = (key) =>
    codexStage({
      stage: 'score',
      cwd: dir,
      dir,
      turnId: 'turn',
      prompt: '读取已冻结证据',
      stageCacheKey: key,
    });
  const first = await run('bound-key');
  const second = await run('bound-key');
  assert.deepEqual(first, second);
  assert.equal(
    readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
    1,
  );
  await run('changed-source-key');
  assert.equal(
    readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
    2,
  );
});
