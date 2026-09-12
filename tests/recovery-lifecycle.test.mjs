import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSelfHeal, nextSelfHealAction } from '../lib/self-heal.mjs';
import { selfHealConditions } from '../lib/recovery-conditions.mjs';
import * as upload from '../scripts/solo-schedule.mjs';
import * as batches from '../lib/upload-batches.mjs';
import { soloStatusSnapshot } from '../lib/solo-upload-status.mjs';
const { batchRevision, applyBatchRecovery, batchNeedsReconciliation } = batches;

const now = new Date('2026-09-12T18:00:00+08:00');
const snapshot = () => ({
  config: { enabled: true, autoContinue: true },
  recoveryRevision: 'release-a',
  tasks: [
    {
      id: 'task',
      title: '项目',
      turns: [{ id: 'turn', status: 'failed', stage: 'policy' }],
    },
  ],
  health: {
    active: 3,
    needsAction: true,
    progress: {},
    incidents: [
      {
        id: 'task:turn',
        taskId: 'task',
        turnId: 'turn',
        stage: 'policy',
        state: 'open',
        reason: '题目与历史核心流程重复',
      },
    ],
  },
});
function diagnosed(snap, mode = 'escalation') {
  let state = reconcileSelfHeal(null, snap, +now);
  const incident = Object.values(state.incidents)[0];
  incident.attempts = 2;
  state.jobs.push({
    id: 'diagnosis',
    incidentId: incident.id,
    signature: incident.signature,
    mode,
    state: 'needs_input',
    reason: '没有新的可行任务目标，保留原始证据',
    conditionsKey: selfHealConditions(incident, snap),
    startedAt: now.toISOString(),
  });
  // The legacy row is bound only while its original full conditions match.
  state = reconcileSelfHeal(state, snap, +now + 1);
  return { state, id: incident.id };
}
test('an input-blocked diagnosis survives unrelated releases and repeated heartbeats', () => {
  const snap = snapshot();
  let { state, id } = diagnosed(snap);
  for (let n = 0; n < 10; n++) {
    snap.recoveryRevision = 'console-release-' + n;
    snap.tasks[0].revision = n + 100;
    state = reconcileSelfHeal(state, snap, +now + 60000 * n);
    assert.equal(nextSelfHealAction(state, snap, +now + 60000 * n), null);
    assert.equal(state.incidents[id].state, 'needs_input');
  }
  assert.equal(state.incidents[id].attempts, 2);
  assert.equal(state.jobs.length, 1);
});
test('new factual evidence reopens the same incident without erasing prior diagnosis', () => {
  const snap = snapshot();
  let { state, id } = diagnosed(snap);
  snap.tasks[0].turns[0].automation = {
    runtimeVerification: { reportSha256: 'new-evidence' },
  };
  state = reconcileSelfHeal(state, snap, +now + 60000);
  assert.equal(nextSelfHealAction(state, snap, +now + 60000)?.mode, 'repair');
  assert.equal(state.incidents[id].attempts, 2);
  assert.equal(state.jobs[0].state, 'needs_input');
});
test('one regular input diagnosis can escalate once across a release, not restart regular repair', () => {
  const snap = snapshot();
  let { state } = diagnosed(snap, 'repair');
  snap.recoveryRevision = 'another-release';
  state = reconcileSelfHeal(state, snap, +now + 60000);
  assert.equal(
    nextSelfHealAction(state, snap, +now + 60000)?.mode,
    'escalation',
  );
});
test('legacy input diagnoses with different full conditions are not rebound to current facts', () => {
  const snap = snapshot();
  let state = reconcileSelfHeal(null, snap, +now);
  const incident = Object.values(state.incidents)[0];
  state.jobs.push({
    id: 'unrelated',
    incidentId: incident.id,
    mode: 'escalation',
    state: 'needs_input',
    conditionsKey: 'old-unmatched',
  });
  state = reconcileSelfHeal(state, snap, +now + 1);
  assert.equal(state.jobs[0].evidenceKey, undefined);
  assert.equal(nextSelfHealAction(state, snap, +now + 1)?.mode, 'repair');
});
test('a failed escalation does not restart a diagnosis already waiting for the same inputs', () => {
  const snap = snapshot();
  let { state, id } = diagnosed(snap, 'repair');
  state.jobs.push({
    id: 'failed-escalation',
    incidentId: id,
    mode: 'escalation',
    state: 'failed',
    reason: '升级补丁未通过回归',
    conditionsKey: selfHealConditions(state.incidents[id], snap),
  });
  state = reconcileSelfHeal(state, snap, +now + 1);
  snap.recoveryRevision = 'unrelated-upload-release';
  state = reconcileSelfHeal(state, snap, +now + 60000);
  assert.equal(nextSelfHealAction(state, snap, +now + 60000), null);
  assert.equal(state.incidents[id].state, 'needs_input');
  snap.tasks[0].turns[0].traceExport = {
    verified: true,
    sha256: 'new-original',
  };
  state = reconcileSelfHeal(state, snap, +now + 120000);
  assert.equal(nextSelfHealAction(state, snap, +now + 120000)?.mode, 'repair');
});

const member = (n) => ({
  key: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}:10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sourceDigest: String(n).repeat(64),
  packetDigest: 'a'.repeat(64),
});
const login = (time) => ({
  status: 'authenticated',
  origin: 'https://solo2.jzxhnh.com',
  username: 'niuyuhang',
  account: '牛宇航',
  source: 'browser',
  checkedAt: time.toISOString(),
});
function batch() {
  const state = { runs: {}, login: login(now) };
  const first = upload.claimUpload(state, {
    now,
    attemptId: 'old-owner',
    members: [member(1), member(2), member(3)],
  });
  const ledger = {
    entries: {
      [member(1).key]: {
        state: 'submitted',
        remoteId: 123,
        receiptVerified: true,
        remoteStatus: 'SUBMITTED',
        updatedAt: now.toISOString(),
      },
      [member(2).key]: { state: 'submitting', updatedAt: now.toISOString() },
      [member(3).key]: { state: 'prepared', updatedAt: now.toISOString() },
    },
  };
  return { state, first, ledger };
}
test('ending a partial browser turn yields the fixed batch; uncertain submissions only reconcile', () => {
  const { state, first, ledger } = batch();
  const before = structuredClone(ledger);
  const input = {
    slot: first.slot,
    attemptId: first.attemptId,
    browserWorkEnded: true,
    reason: '本轮浏览器操作已结束，余项待续传',
  };
  assert.equal(typeof upload.yieldUpload, 'function');
  const out = upload.yieldUpload(state, input, ledger, now);
  assert.equal(out.status, 'waiting_resume');
  assert.equal(out.remaining, 2);
  assert.equal(out.uncertain, 1);
  assert.deepEqual(ledger, before);
  assert.equal(state.runs[first.slot].leaseUntil, undefined);
  const later = new Date('2026-09-12T20:00:00+08:00');
  upload.recordLogin(state, login(later), later);
  const resumed = upload.claimUpload(state, {
    now: later,
    attemptId: 'new-owner',
    members: [member(9)],
  });
  assert.equal(resumed.slot, first.slot);
  assert.equal(resumed.mode, 'resume');
  assert.deepEqual(resumed.members, [member(1), member(2), member(3)]);
  const plan = upload.resumePlan(
    state.runs[first.slot],
    { packets: [member(2), member(3)] },
    ledger,
  );
  assert.equal(plan.settled[0].remoteId, 123);
  assert.equal(plan.packets[0].state, 'uncertain');
  assert.match(plan.packets[0].reason, /不得再次提交/);
  assert.equal(plan.packets[1].key, member(3).key);
  assert.throws(() => upload.touchUpload(state, input, later), /MISMATCH/);
});
test('yield requires the original owner and explicit end of browser work; no fabricated login', () => {
  const { state, first, ledger } = batch();
  const before = structuredClone(state);
  assert.equal(typeof upload.yieldUpload, 'function');
  assert.throws(
    () =>
      upload.yieldUpload(
        state,
        {
          slot: first.slot,
          attemptId: 'wrong',
          browserWorkEnded: true,
          reason: '暂停',
        },
        ledger,
        now,
      ),
    /MISMATCH/,
  );
  assert.throws(
    () =>
      upload.yieldUpload(
        state,
        { slot: first.slot, attemptId: first.attemptId, reason: '暂停' },
        ledger,
        now,
      ),
    /YIELD/,
  );
  assert.deepEqual(state, before);
  upload.yieldUpload(
    state,
    {
      slot: first.slot,
      attemptId: first.attemptId,
      browserWorkEnded: true,
      reason: '稍后续传',
    },
    ledger,
    now,
  );
  assert.deepEqual(state.login, before.login);
  assert.equal(
    upload.dueUpload(new Date('2026-09-13T02:00:00+08:00'), state).due,
    false,
  );
  assert.equal(
    upload.dueUpload(new Date('2026-09-13T08:00:00+08:00'), state).slot,
    first.slot,
  );
});
test('expiry is a display/reconciliation condition, never an automatic new claim', () => {
  const { state, first, ledger } = batch();
  const run = state.runs[first.slot];
  const later = new Date(+now + upload.attemptLeaseMs + 1);
  assert.equal(batchNeedsReconciliation(run, now), false);
  assert.equal(batchNeedsReconciliation(run, later), true);
  assert.equal(
    upload.claimUpload(state, { now: later, attemptId: 'intruder' }).claimed,
    false,
  );
  const request = { slot: first.slot, revision: batchRevision(run) };
  assert.equal(applyBatchRecovery(state, request, later), true);
  assert.equal(run.status, 'running');
  assert.equal(run.attemptId, first.attemptId);
  const display = soloStatusSnapshot(
    ledger,
    { entries: {} },
    later.toISOString(),
    state,
  );
  assert.equal(display.batches[0].leaseUntil, run.leaseUntil);
  upload.touchUpload(
    state,
    { slot: first.slot, attemptId: first.attemptId },
    later,
  );
  assert.equal(
    applyBatchRecovery(
      state,
      request,
      new Date(+later + upload.attemptLeaseMs + 1),
    ),
    false,
  );
});
