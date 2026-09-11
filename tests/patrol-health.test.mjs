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
  assert.equal(n.noLongerLatest.length, 1);
});
