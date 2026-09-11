import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  uploadSlot,
  preflightSlot,
  dueUpload,
  recordLogin,
  claimUpload,
  touchUpload,
  finishUpload,
  resumePlan,
  loginMaxAgeMs,
  attemptLeaseMs,
  uploadAllowed,
  assertUploadWindow,
} from '../scripts/solo-schedule.mjs';

const at = (time) => new Date(time);
const start = at('2026-09-10T08:00:00+08:00');
const firstSlot = '2026-09-10T08:00+08:00';
const member = (n = 1) => ({
  key: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}:10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sourceDigest: String(n % 10).repeat(64),
  packetDigest: String((n + 1) % 10).repeat(64),
});
const observation = (now = start, change = {}) => ({
  status: 'authenticated',
  origin: 'https://solo2.jzxhnh.com',
  username: 'niuyuhang',
  account: '牛宇航',
  checkedAt: now.toISOString(),
  source: 'browser',
  ...change,
});
const loggedIn = (now = start) => ({ runs: {}, login: observation(now) });
const claim = (state = loggedIn(), now = start, members = [member(1)]) =>
  claimUpload(state, { now, members, attemptId: randomUUID() });
const finish = (state, attempt, status, now, extra = {}) =>
  finishUpload(
    state,
    { slot: attempt.slot, attemptId: attempt.attemptId, status, ...extra },
    now,
  );

test('daytime two-hour Shanghai windows have half-hour boundaries and no overnight preflight', () => {
  for (let h = 9; h < 22; h += 2) {
    const hour = String(h).padStart(2, '0');
    const upcoming = String((h + 1) % 24).padStart(2, '0');
    const day = h === 23 ? '2026-09-11' : '2026-09-10';
    assert.equal(preflightSlot(at(`2026-09-10T${hour}:29:59+08:00`)), null);
    assert.equal(
      preflightSlot(at(`2026-09-10T${hour}:30:00+08:00`)),
      `${day}T${upcoming}:00+08:00`,
    );
    assert.equal(
      preflightSlot(at(`2026-09-10T${hour}:59:59+08:00`)),
      `${day}T${upcoming}:00+08:00`,
    );
    assert.equal(uploadSlot(at(`2026-09-10T${hour}:59:59+08:00`)), null);
    assert.equal(
      uploadSlot(at(`${day}T${upcoming}:29:59+08:00`)),
      `${day}T${upcoming}:00+08:00`,
    );
    assert.equal(uploadSlot(at(`2026-09-10T${upcoming}:30:00+08:00`)), null);
    assert.equal(preflightSlot(at(`2026-09-10T${upcoming}:00:00+08:00`)), null);
  }
  assert.equal(uploadSlot(at('2026-09-10T00:00:00Z')), firstSlot);
  for (const time of [
    '00:00:00',
    '02:00:00',
    '04:00:00',
    '06:00:00',
    '07:59:59',
  ]) {
    const now = at(`2026-09-10T${time}+08:00`);
    assert.equal(uploadAllowed(now), false);
    assert.throws(
      () => assertUploadWindow(now),
      /UPLOAD_PAUSED_UNTIL_08_SHANGHAI/,
    );
    assert.equal(uploadSlot(now), null);
    assert.equal(preflightSlot(now), null);
  }
  for (const time of ['07:30:00', '23:30:00'])
    assert.equal(preflightSlot(at(`2026-12-31T${time}+08:00`)), null);
  assert.equal(uploadAllowed(at('2026-09-10T23:59:59+08:00')), true);
  assert.doesNotThrow(() => assertUploadWindow(start));
  const due = dueUpload(start, { runs: {} });
  assert.deepEqual(due.times, [
    '08:00',
    '10:00',
    '12:00',
    '14:00',
    '16:00',
    '18:00',
    '20:00',
    '22:00',
  ]);
  assert.deepEqual(due.loginTimes, [
    '09:30',
    '11:30',
    '13:30',
    '15:30',
    '17:30',
    '19:30',
    '21:30',
  ]);
});

test('new two-hour windows preserve completed old batches and prioritize unfinished batches', () => {
  const old = {
    version: '2026-09-10.login-resume1',
    runs: { [firstSlot]: { status: 'completed' } },
  };
  assert.equal(dueUpload(start, old).due, false);
  const ten = at('2026-09-10T10:00:00+08:00');
  assert.equal(dueUpload(ten, old).slot, '2026-09-10T10:00+08:00');
  old.runs[firstSlot] = {
    status: 'waiting_login',
    reasonCode: 'session_expired',
    members: [member()],
  };
  assert.equal(dueUpload(ten, old).slot, firstSlot);
  assert.equal(dueUpload(ten, old).mode, 'resume');
  old.runs[firstSlot] = {
    status: 'running',
    attemptId: 'existing',
    leaseUntil: '2026-09-10T10:30:00+08:00',
  };
  assert.equal(dueUpload(ten, old).due, false);
  assert.equal(dueUpload(ten, old).active.attemptId, 'existing');
});

test('preflight records login without starting or completing an upload batch', () => {
  const state = { runs: {} };
  const now = at('2026-09-10T09:30:00+08:00');
  const due = dueUpload(now, state);
  assert.equal(due.preflightDue, true);
  assert.equal(due.loginCheckDue, true);
  assert.equal(due.due, false);
  const result = recordLogin(state, observation(now), now);
  assert.equal(result.preflightDue, false);
  assert.deepEqual(state.runs, {});
  assert.equal(claim(state, now).claimed, false);
  assert.deepEqual(state.runs, {});
});

test('login freshness is checked at claim time with exact TTL and no future observations', () => {
  const state = loggedIn();
  assert.equal(
    dueUpload(new Date(start.getTime() + loginMaxAgeMs), state).canClaim,
    true,
  );
  assert.equal(
    dueUpload(new Date(start.getTime() + loginMaxAgeMs + 1), state).canClaim,
    false,
  );
  state.login.checkedAt = new Date(start.getTime() + 1).toISOString();
  assert.equal(dueUpload(start, state).canClaim, false);
  state.login.checkedAt = 'invalid';
  assert.equal(dueUpload(start, state).canClaim, false);
});

test('login observations reject wrong account, origin, source, unknown fields, stale and future timestamps', () => {
  for (const change of [
    { username: 'other' },
    { account: 'other' },
    { origin: 'https://other.example' },
    { source: 'api' },
    { password: 'fixture-should-never-be-stored' },
    { status: 'ready' },
    { checkedAt: 'invalid' },
    { checkedAt: new Date(start.getTime() + 1).toISOString() },
    { checkedAt: new Date(start.getTime() - loginMaxAgeMs - 1).toISOString() },
  ]) {
    const state = { runs: {} };
    assert.throws(
      () => recordLogin(state, observation(start, change), start),
      /LOGIN_/,
    );
    assert.equal(state.login, undefined);
  }
});

test('an older login response cannot replace a newer observation', () => {
  const state = loggedIn(new Date(start.getTime() + 1000));
  assert.throws(
    () =>
      recordLogin(
        state,
        observation(start, { status: 'session_expired' }),
        new Date(start.getTime() + 1000),
      ),
    /OUT_OF_ORDER/,
  );
  assert.equal(state.login.status, 'authenticated');
});

test('repeated unchanged login failures stay quiet and recovery is reported once', () => {
  const state = { runs: {} };
  assert.equal(
    recordLogin(state, observation(start, { status: 'login_required' }), start)
      .notify,
    true,
  );
  assert.equal(
    recordLogin(state, observation(start, { status: 'login_required' }), start)
      .notify,
    false,
  );
  const recovery = recordLogin(state, observation(), start);
  assert.equal(recovery.notify, true);
  assert.equal(recovery.recovered, true);
  assert.equal(recordLogin(state, observation(), start).notify, false);
});

test('claim persists the original batch even when login is missing', () => {
  const state = { runs: {} };
  const first = claim(state);
  assert.equal(first.claimed, false);
  assert.equal(first.status, 'waiting_login');
  assert.equal(first.reasonCode, 'login_required');
  assert.deepEqual(state.runs[firstSlot].members, [member(1)]);
  const now = at('2026-09-10T09:00:00+08:00');
  recordLogin(state, observation(now), now);
  const resumed = claim(state, now, [member(2)]);
  assert.equal(resumed.claimed, true);
  assert.equal(resumed.slot, firstSlot);
  assert.equal(resumed.mode, 'resume');
  assert.deepEqual(resumed.members, [member(1)]);
});

test('login recovery at night waits until 08:00 and resumes the original batch without inventing missed batches', () => {
  const state = { runs: {} };
  claim(state);
  const tomorrow = at('2026-09-11T03:00:00+08:00');
  recordLogin(state, observation(tomorrow), tomorrow);
  const before = structuredClone(state);
  const paused = claim(state, tomorrow);
  assert.equal(paused.claimed, false);
  assert.equal(paused.uploadPaused, true);
  assert.equal(paused.loginCheckDue, false);
  assert.equal(paused.nextUploadAt, '2026-09-11T08:00+08:00');
  assert.deepEqual(state, before);
  const morning = at('2026-09-11T08:00:00+08:00');
  recordLogin(state, observation(morning), morning);
  const resumed = claim(state, morning);
  assert.equal(resumed.claimed, true);
  assert.equal(resumed.slot, firstSlot);
  assert.equal(resumed.mode, 'resume');
  assert.deepEqual(Object.keys(state.runs), [firstSlot]);
  assert.equal(dueUpload(tomorrow, { runs: {} }).due, false);
});

test('a batch crossing midnight pauses after receipt reconciliation and resumes remaining fixed members at 08:00', () => {
  const evening = at('2026-12-31T22:00:00+08:00');
  const state = loggedIn(evening);
  const first = claim(state, evening);
  const midnight = at('2027-01-01T00:00:00+08:00');
  const due = dueUpload(midnight, state);
  assert.equal(due.due, false);
  assert.equal(due.loginCheckDue, false);
  assert.equal(due.active.attemptId, first.attemptId);
  assert.equal(due.active.action, 'finish_receipts_then_pause');
  assert.equal(touchUpload(state, first, midnight).uploadPaused, true);
  finish(state, first, 'waiting_window', midnight, {
    counts: { uncertain: 1 },
  });
  assert.equal(state.runs[first.slot].status, 'waiting_window');
  assert.equal(
    state.login.status,
    'authenticated',
    'night pause is not a login failure',
  );
  const before = structuredClone(state);
  assert.equal(claim(state, midnight).claimed, false);
  assert.deepEqual(state, before);
  const morning = at('2027-01-01T08:00:00+08:00');
  assert.equal(
    dueUpload(morning, state).canClaim,
    false,
    'login must be freshly checked',
  );
  recordLogin(state, observation(morning), morning);
  const second = claim(state, morning, [member(2)]);
  assert.equal(second.claimed, true);
  assert.equal(second.slot, first.slot);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.deepEqual(second.members, [member(1)]);
  const plan = resumePlan(
    state.runs[first.slot],
    { packets: [member(1)] },
    {
      entries: { [member(1).key]: { state: 'submitting' } },
    },
  );
  assert.equal(plan.packets[0].state, 'uncertain');
});

test('duplicate claims and expired running attempts never cause a second upload owner', () => {
  const state = loggedIn();
  const first = claim(state);
  const duplicate = claim(state);
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.active.attemptId, first.attemptId);
  const later = new Date(start.getTime() + attemptLeaseMs + 1);
  const expired = dueUpload(later, state);
  assert.equal(expired.due, false);
  assert.equal(expired.active.leaseExpired, true);
  assert.equal(expired.active.action, 'reconcile_existing_attempt_only');
  assert.equal(claim(state, later).claimed, false);
  assert.equal(state.runs[firstSlot].attempts.length, 1);
});

test('touch renews only the owning attempt; old finish and touch cannot overwrite a resumed attempt', () => {
  const state = loggedIn();
  const first = claim(state);
  const nextMinute = new Date(start.getTime() + 60000);
  const touched = touchUpload(state, first, nextMinute);
  assert.equal(
    Date.parse(touched.leaseUntil),
    nextMinute.getTime() + attemptLeaseMs,
  );
  assert.throws(
    () => touchUpload(state, { ...first, attemptId: 'other' }, nextMinute),
    /MISMATCH/,
  );
  finish(state, first, 'waiting_login', nextMinute, {
    reasonCode: 'session_expired',
  });
  const later = at('2026-09-10T11:00:00+08:00');
  recordLogin(state, observation(later), later);
  const second = claim(state, later);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.throws(() => touchUpload(state, first, later), /MISMATCH/);
  assert.throws(() => finish(state, first, 'completed', later), /MISMATCH/);
  assert.equal(state.runs[firstSlot].attemptId, second.attemptId);
  assert.equal(state.runs[firstSlot].status, 'running');
});

test('finish validates status, reason and counters before changing the running attempt', () => {
  const state = loggedIn();
  const first = claim(state);
  for (const [status, extra] of [
    ['finished', {}],
    ['waiting_login', { reasonCode: 'network_error' }],
    ['waiting_login', {}],
    ['completed', { counts: { uploaded: -1 } }],
    ['completed', { counts: { arbitrary: 1 } }],
    ['completed', { counts: { uploaded: 0.5 } }],
  ]) {
    assert.throws(() => finish(state, first, status, start, extra));
    assert.equal(state.runs[firstSlot].status, 'running');
  }
  finish(state, first, 'waiting_login', start, {
    reasonCode: 'challenge_required',
  });
  assert.equal(state.login.status, 'challenge_required');
  assert.equal(dueUpload(start, state).canClaim, false);
});

test('completed batches and nonlogin or unclassified blocked failures do not auto-resume', () => {
  for (const run of [
    { status: 'completed' },
    { status: 'failed' },
    { status: 'blocked' },
    {
      status: 'waiting_login',
      reasonCode: 'evidence_invalid',
      members: [member(1)],
    },
    { status: 'waiting_login', members: [member(1)] },
  ]) {
    const state = { ...loggedIn(), runs: { [firstSlot]: run } };
    assert.equal(dueUpload(start, state).due, false);
  }
});

test('empty batches settle once while invalid or duplicate members are rejected', () => {
  const state = { runs: {} };
  assert.equal(claim(state, start, []).empty, true);
  assert.equal(state.runs[firstSlot].status, 'completed');
  assert.equal(claim(state).claimed, false);
  for (const members of [
    undefined,
    [member(1), member(1)],
    [{ ...member(1), key: 'wrong' }],
    [{ ...member(1), packetDigest: 'short' }],
  ]) {
    assert.throws(
      () => claimUpload({ runs: {} }, { now: start, members }),
      /MEMBERS_INVALID/,
    );
  }
});

test('resume plans exclude new records and block changes to the fixed source or packet', () => {
  const run = { members: [member(1), member(2), member(3), member(4)] };
  const plan = {
    packets: [
      member(1),
      { ...member(2), sourceDigest: 'e'.repeat(64) },
      { ...member(3), packetDigest: 'f'.repeat(64) },
      member(5),
    ],
  };
  const result = resumePlan(run, plan, { entries: {} });
  assert.deepEqual(result.packets, [member(1)]);
  assert.deepEqual(
    result.blocked.map((p) => p.key),
    [member(2).key, member(3).key, member(4).key],
  );
  assert.equal(JSON.stringify(result).includes(member(5).key), false);
});

test('submitting and uncertain records remain lookup-only even if a fresh prepared packet exists', () => {
  for (const status of ['submitting', 'uncertain']) {
    const result = resumePlan(
      { members: [member(1)] },
      { packets: [{ ...member(1), state: 'prepared' }] },
      {
        entries: { [member(1).key]: { state: status } },
      },
    );
    assert.equal(result.packets[0].state, 'uncertain');
    assert.match(result.packets[0].reason, /不得再次提交/);
    assert.deepEqual(result.settled, []);
  }
});

test('only a verified remote receipt is settled; an unverified ID still needs read-only reconciliation', () => {
  const run = { members: [member(1), member(2)] };
  const result = resumePlan(
    run,
    { packets: [member(1), member(2)] },
    {
      entries: {
        [member(1).key]: { remoteId: 123, receiptVerified: true },
        [member(2).key]: { remoteId: 124, receiptVerified: false },
      },
    },
  );
  assert.deepEqual(result.settled, [{ key: member(1).key, remoteId: 123 }]);
  assert.equal(result.packets[0].key, member(2).key);
  assert.equal(result.packets[0].state, 'uncertain');
});

test('file-backed scheduling persists and resumes only its isolated root with a fixed packet set', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-schedule-'));
  const previousRoot = process.env.SOLO_SCHEDULE_ROOT;
  try {
    process.env.SOLO_SCHEDULE_ROOT = directory;
    const moduleURL = new URL('../scripts/solo-schedule.mjs', import.meta.url);
    moduleURL.searchParams.set('isolated-test', randomUUID());
    const { runSchedule } = await import(moduleURL.href);
    if (previousRoot === undefined) delete process.env.SOLO_SCHEDULE_ROOT;
    else process.env.SOLO_SCHEDULE_ROOT = previousRoot;
    const write = (name, data) => {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
      return file;
    };
    const packetPath = write(
      'packets/' + member(1).key.replace(':', '_') + '.json',
      {
        key: member(1).key,
        sourceDigest: member(1).sourceDigest,
        digest: member(1).packetDigest,
      },
    );
    const plan = write('plan.json', {
      packets: [{ key: member(1).key, packetPath, state: 'prepared' }],
    });
    const waiting = await runSchedule('--claim', plan, start);
    assert.equal(waiting.status, 'waiting_login');
    assert.equal(fs.existsSync(path.join(directory, 'journal.lock')), false);
    const later = at('2026-09-10T11:00:00+08:00');
    const login = write('login.json', observation(later));
    await runSchedule('--login-result', login, later);
    const resumed = await runSchedule('--claim', undefined, later);
    assert.equal(resumed.claimed, true);
    assert.equal(resumed.slot, firstSlot);
    const input = write('batch-input.json', { ...resumed, planPath: plan });
    const current = await runSchedule('--batch-plan', input, later);
    assert.equal(current.packets.length, 1);
    const summary = write('summary.json', {
      slot: resumed.slot,
      attemptId: resumed.attemptId,
      status: 'completed',
      counts: { uploaded: 1 },
    });
    await runSchedule('--finish', summary, later);
    const saved = JSON.parse(
      fs.readFileSync(path.join(directory, 'schedule.json'), 'utf8'),
    );
    assert.equal(saved.runs[firstSlot].status, 'completed');
    assert.equal(
      fs.statSync(path.join(directory, 'schedule.json')).mode & 0o077,
      0,
    );
    assert.equal((await runSchedule('--due', undefined, later)).due, false);
    await assert.rejects(runSchedule('--finish', summary, later), /MISMATCH/);
    assert.equal(fs.existsSync(path.join(directory, 'journal.lock')), false);
  } finally {
    if (previousRoot === undefined) delete process.env.SOLO_SCHEDULE_ROOT;
    else process.env.SOLO_SCHEDULE_ROOT = previousRoot;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
