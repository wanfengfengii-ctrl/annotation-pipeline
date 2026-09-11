import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { savePrivateJSON, SOLO_ORIGIN } from './solo-client.mjs';
import { withSoloLock } from './solo-lock.mjs';

export const scheduleVersion = '2026-09-11.daytime-two-hour1';
const uploadHours = Array.from({ length: 8 }, (_, i) =>
  String(8 + i * 2).padStart(2, '0'),
);
export const uploadTimes = uploadHours.map((hour) => `${hour}:00`);
// The first batch checks login at 08:00; overnight has no upload preflight.
export const loginTimes = uploadHours
  .slice(1)
  .map((hour) => `${String(Number(hour) - 1).padStart(2, '0')}:30`);
export const loginMaxAgeMs = 5 * 60 * 1000;
export const attemptLeaseMs = 45 * 60 * 1000;
const loginFailures = new Set([
  'login_required',
  'session_expired',
  'account_mismatch',
  'challenge_required',
  'credentials_rejected',
  'unavailable',
]);
const loginStates = new Set(['authenticated', ...loginFailures]);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const keyValid = (v) =>
  typeof v === 'string' && /^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(v);
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const root = path.resolve(
  process.env.SOLO_SCHEDULE_ROOT ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../.runner/solo-upload',
    ),
);

function shanghai(now) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
}
const slotFor = (p, hour) => `${p.year}-${p.month}-${p.day}T${hour}:00+08:00`;
export function uploadAllowed(now = new Date()) {
  return Number(shanghai(now).hour) >= 8;
}
export function assertUploadWindow(now = new Date()) {
  if (!uploadAllowed(now)) fail('UPLOAD_PAUSED_UNTIL_08_SHANGHAI');
}
export function uploadSlot(now = new Date()) {
  const p = shanghai(now);
  return uploadHours.includes(p.hour) && Number(p.minute) < 30
    ? slotFor(p, p.hour)
    : null;
}
export function preflightSlot(now = new Date()) {
  const p = shanghai(now);
  if (!uploadAllowed(now) || Number(p.hour) % 2 !== 1 || Number(p.minute) < 30)
    return null;
  const upcoming = shanghai(new Date(now.getTime() + 30 * 60 * 1000));
  return uploadHours.includes(upcoming.hour)
    ? slotFor(upcoming, upcoming.hour)
    : null;
}
function freshLogin(now, login) {
  const age = now.getTime() - Date.parse(login?.checkedAt);
  return (
    login?.status === 'authenticated' &&
    login.origin === SOLO_ORIGIN &&
    login.username === 'niuyuhang' &&
    login.account === '牛宇航' &&
    age >= 0 &&
    age <= loginMaxAgeMs
  );
}
export function dueUpload(now, state) {
  const uploadPaused = !uploadAllowed(now);
  const runs = Object.entries(state.runs || {});
  const active = runs.find(([, r]) => r.status === 'running');
  const pending = runs
    .filter(
      ([, r]) =>
        (r.status === 'waiting_window' ||
          (r.status === 'waiting_login' && loginFailures.has(r.reasonCode))) &&
        Array.isArray(r.members),
    )
    .sort(([a], [b]) => a.localeCompare(b))[0];
  const window = uploadSlot(now);
  const slot =
    active || uploadPaused
      ? null
      : pending?.[0] || (window && !state.runs?.[window] ? window : null);
  const preflight = preflightSlot(now);
  const preflightDue = !active && !!preflight && !state.preflights?.[preflight];
  const authenticated = freshLogin(now, state.login);
  return {
    version: scheduleVersion,
    uploadPaused,
    nextUploadAt: uploadPaused ? slotFor(shanghai(now), '08') : null,
    due: !!slot,
    slot,
    mode: slot ? (pending ? 'resume' : 'new') : null,
    canClaim: !!slot && authenticated,
    loginCheckDue: !active && (preflightDue || (!!slot && !authenticated)),
    preflightDue,
    preflightSlot: preflight,
    active: active
      ? {
          slot: active[0],
          attemptId: active[1].attemptId || null,
          leaseExpired:
            !active[1].leaseUntil ||
            !Number.isFinite(Date.parse(active[1].leaseUntil)) ||
            Date.parse(active[1].leaseUntil) <= now.getTime(),
          action: uploadPaused
            ? 'finish_receipts_then_pause'
            : 'reconcile_existing_attempt_only',
        }
      : null,
    timezone: 'Asia/Shanghai',
    times: [...uploadTimes],
    loginTimes: [...loginTimes],
  };
}

export function recordLogin(state, observation, now = new Date()) {
  const allowed = new Set([
    'status',
    'origin',
    'username',
    'account',
    'checkedAt',
    'source',
  ]);
  if (
    Object.keys(observation).some((k) => !allowed.has(k)) ||
    !loginStates.has(observation.status) ||
    observation.origin !== SOLO_ORIGIN ||
    observation.source !== 'browser'
  )
    fail('LOGIN_OBSERVATION_INVALID');
  const age = now.getTime() - Date.parse(observation.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > loginMaxAgeMs)
    fail('LOGIN_OBSERVATION_STALE');
  if (
    state.login &&
    Date.parse(state.login.checkedAt) > Date.parse(observation.checkedAt)
  )
    fail('LOGIN_OBSERVATION_OUT_OF_ORDER');
  if (
    observation.status === 'authenticated' &&
    (observation.username !== 'niuyuhang' || observation.account !== '牛宇航')
  )
    fail('LOGIN_ACCOUNT_MISMATCH');
  const prior = state.login?.status;
  state.login = {
    status: observation.status,
    origin: SOLO_ORIGIN,
    ...(observation.status === 'authenticated'
      ? { username: 'niuyuhang', account: '牛宇航' }
      : {}),
    checkedAt: observation.checkedAt,
    source: 'browser',
  };
  const slot = preflightSlot(now);
  if (slot) {
    state.preflights ||= {};
    state.preflights[slot] = {
      status: observation.status,
      checkedAt: observation.checkedAt,
    };
  }
  // Notify on state changes, including recovery; repeated failures stay quiet.
  return {
    status: observation.status,
    notify:
      prior !== observation.status &&
      (prior !== undefined || observation.status !== 'authenticated'),
    recovered:
      !!prior &&
      prior !== 'authenticated' &&
      observation.status === 'authenticated',
    ...dueUpload(now, state),
  };
}

function validateMembers(members) {
  if (
    !Array.isArray(members) ||
    members.length > 1000 ||
    new Set(members.map((m) => m.key)).size !== members.length ||
    members.some(
      (m) => !keyValid(m.key) || !sha(m.sourceDigest) || !sha(m.packetDigest),
    )
  )
    fail('BATCH_MEMBERS_INVALID');
  return members.map(({ key, sourceDigest, packetDigest }) => ({
    key,
    sourceDigest,
    packetDigest,
  }));
}
export function claimUpload(
  state,
  { now = new Date(), members, attemptId = randomUUID() } = {},
) {
  const due = dueUpload(now, state);
  if (!due.due) return { ...due, claimed: false };
  state.runs ||= {};
  let run = state.runs[due.slot];
  if (!run) {
    run = state.runs[due.slot] = {
      version: scheduleVersion,
      status: 'waiting_login',
      createdAt: now.toISOString(),
      members: validateMembers(members),
      attempts: [],
    };
  }
  if (!run.members.length) {
    run.status = 'completed';
    run.finishedAt = now.toISOString();
    return { claimed: false, slot: due.slot, status: 'completed', empty: true };
  }
  if (!freshLogin(now, state.login)) {
    run.status = 'waiting_login';
    run.reasonCode = loginFailures.has(state.login?.status)
      ? state.login.status
      : 'login_required';
    return {
      claimed: false,
      slot: due.slot,
      status: run.status,
      loginCheckDue: true,
      members: run.members,
      reasonCode: run.reasonCode,
    };
  }
  run.status = 'running';
  run.attemptId = attemptId;
  run.startedAt = now.toISOString();
  run.leaseUntil = new Date(now.getTime() + attemptLeaseMs).toISOString();
  delete run.reasonCode;
  run.attempts ||= [];
  run.attempts.push({ attemptId, startedAt: run.startedAt, mode: due.mode });
  return {
    claimed: true,
    slot: due.slot,
    mode: due.mode,
    attemptId,
    leaseUntil: run.leaseUntil,
    members: run.members,
  };
}
function ownedRun(state, input) {
  const run = state.runs?.[input.slot];
  if (
    !run ||
    run.status !== 'running' ||
    !run.attemptId ||
    run.attemptId !== input.attemptId
  )
    fail('BATCH_ATTEMPT_MISMATCH');
  return run;
}
export function touchUpload(state, input, now = new Date()) {
  const run = ownedRun(state, input);
  run.leaseUntil = new Date(now.getTime() + attemptLeaseMs).toISOString();
  return {
    slot: input.slot,
    attemptId: input.attemptId,
    leaseUntil: run.leaseUntil,
    uploadPaused: !uploadAllowed(now),
  };
}
export function finishUpload(state, input, now = new Date()) {
  const run = ownedRun(state, input);
  if (
    ![
      'completed',
      'waiting_login',
      'waiting_window',
      'blocked',
      'failed',
    ].includes(input.status)
  )
    fail('BATCH_STATUS_INVALID');
  if (input.status === 'waiting_login' && !loginFailures.has(input.reasonCode))
    fail('LOGIN_REASON_REQUIRED');
  const counts = input.counts || {};
  if (
    Object.keys(counts).some(
      (k) => !['uploaded', 'existing', 'blocked', 'uncertain'].includes(k),
    ) ||
    Object.values(counts).some((v) => !Number.isSafeInteger(v) || v < 0)
  )
    fail('BATCH_COUNTS_INVALID');
  run.status = input.status;
  run.finishedAt = now.toISOString();
  run.counts = { ...counts };
  if (input.status === 'waiting_login') {
    run.reasonCode = input.reasonCode;
    // An interruption invalidates even a recent successful browser observation.
    state.login = {
      status: input.reasonCode,
      origin: SOLO_ORIGIN,
      source: 'browser',
      checkedAt: now.toISOString(),
    };
  }
  delete run.leaseUntil;
  Object.assign(run.attempts.at(-1), {
    status: input.status,
    finishedAt: run.finishedAt,
    counts: run.counts,
    ...(input.status === 'waiting_login'
      ? { reasonCode: input.reasonCode }
      : {}),
  });
  return { slot: input.slot, attemptId: input.attemptId, status: run.status };
}

export function resumePlan(run, plan, ledger) {
  const packets = [],
    blocked = [],
    settled = [];
  const current = new Map(plan.packets.map((p) => [p.key, p]));
  for (const member of run.members) {
    const entry = ledger.entries?.[member.key];
    if (entry?.remoteId && entry.receiptVerified === true) {
      settled.push({ key: member.key, remoteId: entry.remoteId });
      continue;
    }
    if (entry?.remoteId || ['submitting', 'uncertain'].includes(entry?.state)) {
      packets.push({
        key: member.key,
        state: 'uncertain',
        ...(entry.remoteId ? { remoteId: entry.remoteId } : {}),
        ...(current.get(member.key)?.packetPath
          ? { packetPath: current.get(member.key).packetPath }
          : {}),
        reason: '仅查询远端回执，不得再次提交',
      });
      continue;
    }
    const p = current.get(member.key);
    if (
      !p ||
      p.sourceDigest !== member.sourceDigest ||
      p.packetDigest !== member.packetDigest
    ) {
      blocked.push({
        key: member.key,
        reason: '本批原件已变化或当前准入未通过，留待核对',
      });
      continue;
    }
    packets.push(p);
  }
  return { packets, blocked, settled };
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail('JSON_FILE_INVALID');
  }
}
function loadPlan(file) {
  const plan = readJSON(file);
  if (!Array.isArray(plan.packets) || plan.packets.length > 1000)
    fail('BATCH_PLAN_INVALID');
  return {
    ...plan,
    packets: plan.packets.map((p) => {
      if (!keyValid(p.key)) fail('BATCH_KEY_INVALID');
      const expected = path.join(
        root,
        'packets',
        p.key.replace(':', '_') + '.json',
      );
      if (path.resolve(p.packetPath || '') !== expected)
        fail('PACKET_PATH_INVALID');
      const packet = readJSON(expected);
      if (
        packet.key !== p.key ||
        !sha(packet.sourceDigest) ||
        !sha(packet.digest)
      )
        fail('PACKET_INVALID');
      return {
        ...p,
        sourceDigest: packet.sourceDigest,
        packetDigest: packet.digest,
      };
    }),
  };
}
export async function runSchedule(action, file, now = new Date()) {
  const scheduleFile = path.join(root, 'schedule.json');
  const load = () =>
    fs.existsSync(scheduleFile)
      ? readJSON(scheduleFile)
      : { version: scheduleVersion, runs: {} };
  if (action === '--due') return dueUpload(now, load());
  return withSoloLock(path.join(root, 'journal.lock'), async () => {
    const state = load();
    let result;
    if (action === '--login-result')
      result = recordLogin(state, readJSON(file), now);
    else if (action === '--claim') {
      const due = dueUpload(now, state);
      const plan = due.mode === 'new' && due.due ? loadPlan(file) : null;
      result = claimUpload(state, { now, members: plan?.packets });
    } else if (action === '--touch')
      result = touchUpload(state, readJSON(file), now);
    else if (action === '--finish')
      result = finishUpload(state, readJSON(file), now);
    else if (action === '--batch-plan') {
      const input = readJSON(file),
        run = ownedRun(state, input);
      result = resumePlan(
        run,
        loadPlan(input.planPath),
        fs.existsSync(path.join(root, 'ui-state.json'))
          ? readJSON(path.join(root, 'ui-state.json'))
          : { entries: {} },
      );
    } else fail('USAGE_DUE_LOGIN_RESULT_CLAIM_TOUCH_FINISH_BATCH_PLAN');
    state.version = scheduleVersion;
    savePrivateJSON(scheduleFile, state);
    return result;
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runSchedule(process.argv[2], process.argv[3])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.code || 'SOLO_SCHEDULE_FAILED');
      process.exitCode = 1;
    });
