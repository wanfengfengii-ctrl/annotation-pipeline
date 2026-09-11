import test from 'node:test';
import assert from 'node:assert/strict';
import { patrolHealth } from '../lib/patrol-health.mjs';
const now = Date.parse('2026-09-12T00:00:00Z');
const input = {
  tasks: [
    {
      id: 'project',
      title: '项目',
      projectSeries: {},
      turns: [
        {
          id: 'turn',
          status: 'failed',
          stage: 'runtime-diagnose',
          error: '验收脚本失败',
        },
      ],
    },
  ],
  runner: {
    heartbeat: new Date(now).toISOString(),
    scheduler: { active: 0, effective: 3 },
  },
  config: { enabled: true, autoContinue: true },
  now,
};
test('healthy API and unchanged failure never count as recovered production', () => {
  const first = patrolHealth(input);
  assert.equal(first.needsAction, true);
  const next = patrolHealth({
    ...input,
    previous: first,
    now: now + 15 * 60000,
  });
  assert.equal(next.status, 'stalled');
  assert.equal(next.needsAction, true);
  assert.equal(next.incidents[0].unchanged, true);
  assert.equal(next.incidents[0].firstSeenAt, first.incidents[0].firstSeenAt);
});
test('queued work with no execution becomes stalled on repeated observation', () => {
  const i = structuredClone(input);
  i.tasks[0].turns[0].status = 'queued';
  const first = patrolHealth(i);
  assert.equal(first.status, 'idle_observation');
  assert.equal(
    patrolHealth({ ...i, previous: first, now: now + 60000 }).stalled,
    true,
  );
});
test('user pause preserves unresolved incidents without treating it as a production outage', () => {
  const p = patrolHealth({
    ...input,
    config: { enabled: false, autoContinue: false },
  });
  assert.equal(p.status, 'paused');
  assert.equal(p.needsAction, false);
  assert.equal(p.incidents.length, 1);
});
test('one working project does not hide another failed project or count a queued retry as completion', () => {
  const p = patrolHealth({
    ...input,
    runner: { scheduler: { active: 1, effective: 3 } },
  });
  assert.equal(p.status, 'unresolved_failures');
  assert.equal(p.needsAction, true);
  assert.equal(p.latestCompleted, null);
  const next = structuredClone(input);
  next.tasks[0].turns[0].status = 'queued';
  const n = patrolHealth({ ...next, previous: p });
  assert.equal(n.latestCompleted, null);
  assert.equal(n.noLongerLatest.length, 0);
  assert.equal(n.incidents[0].state, 'recovery_in_progress');
  assert.equal(n.needsFollowup, true);
});

test('a completed evaluation with blocked project continuation still needs action', () => {
  const next = structuredClone(input);
  Object.assign(next.tasks[0].turns[0], {
    status: 'review',
    automation: { delivery: { value: { passed: true } } },
    projectRecovery: { state: 'blocked', reason: '续题审核失败', attempts: 3 },
  });
  const p = patrolHealth(next);
  assert.equal(p.incidents[0].reason, '续题审核失败');
  assert.equal(p.needsAction, true);
});

test('recovery remains tracked across phase changes until actual completion', () => {
  let state = patrolHealth(input);
  const next = structuredClone(input);
  next.runner.scheduler.active = 1;
  for (const stage of ['runtime-plan', 'runtime-running', 'score']) {
    Object.assign(next.tasks[0].turns[0], { status: 'running', stage });
    state = patrolHealth({ ...next, previous: state });
    assert.equal(state.incidents.length, 1);
    assert.equal(state.needsFollowup, true);
  }
  Object.assign(next.tasks[0].turns[0], {
    status: 'review',
    finishedAt: new Date(now).toISOString(),
    automation: { delivery: { value: { passed: true } } },
  });
  state = patrolHealth({ ...next, previous: state });
  assert.equal(state.incidents.length, 0);
  assert.equal(state.latestCompleted, new Date(now).toISOString());
});

test('recovered output uses actual delivery time while failed or running attempts are excluded', () => {
  const next = structuredClone(input);
  const completed = new Date(now).toISOString();
  Object.assign(next.tasks[0].turns[0], {
    status: 'review', finishedAt: new Date(now - 6 * 3600000).toISOString(),
    automation: { delivery: { finishedAt: completed, value: { passed: true } } },
  });
  assert.equal(patrolHealth(next).latestCompleted, completed);
  next.tasks[0].turns[0].status = 'running';
  assert.equal(patrolHealth(next).latestCompleted, null);
  next.tasks[0].turns[0].status = 'failed';
  assert.equal(patrolHealth(next).latestCompleted, null);
});
