// Integration with synthetic CLI responses and Docker adapter; no real model calls.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  fixture,
  api,
  start,
  stop,
  waitTask,
  create,
  calls,
} from './fixtures/flow-helper.mjs';
const f = fixture('docker-flow'),
  original = (await api('/api/scheduler', null, 'GET')).config;
let child;
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    useHistory: false,
    repos: [],
    autoContinue: true,
    concurrency: 3,
  });
  writeFileSync(path.join(f.bin, 'fail-score-once'), '1');
  const task = await create(f, '__DOCKER_TEN_ROUNDS__');
  child = start(f);
  let t = await waitTask(task.id, (t) => t.turns[0].status === 'failed');
  assert.equal(t.turns[0].stage, 'score', f.errors);
  await api(
    '/api/tasks/' + t.id,
    { action: 'retry', turnId: t.turns[0].id, revision: t.revision },
    'PATCH',
  );
  t = await waitTask(
    task.id,
    (t) => t.turns.length === 10 && t.turns.every((r) => r.status === 'review'),
    180000,
  );
  assert.equal(new Set(t.turns.map((r) => r.sessionId)).size, 1);
  assert.equal(new Set(t.turns.map((r) => r.promptId)).size, 10);
  assert.equal(
    calls(f).filter((e) => e.name === 'claude' && e.event === 'start').length,
    10,
    'score retry cannot invoke Claude again',
  );
  assert.equal(t.turns.flatMap((r) => r.claudeAttempts).length, 10);
  assert.ok(
    t.turns.every(
      (r) =>
        r.traceExport.verified &&
        r.review.source === 'codex' &&
        r.automation.archive,
    ),
  );
  t = await waitTask(task.id, (t) => t.container?.status === 'removed');
  await assert.rejects(
    api(
      '/api/tasks/' + t.id,
      {
        action: 'enqueue',
        prompt: 'eleventh',
        category: 'Feature 迭代',
        difficulty: '中等',
        revision: t.revision,
      },
      'PATCH',
    ),
    /容器|10/,
  );
  const blocked = await create(f, '__POLICY_REJECT__');
  const rejected = await waitTask(
    blocked.id,
    (t) => t.turns[0].status === 'failed',
  );
  assert.equal(rejected.turns[0].stage, 'policy');
  assert.equal(
    calls(f).filter((e) => e.name === 'claude' && e.event === 'start').length,
    10,
  );
  await api(
    '/api/tasks/' + rejected.id,
    { action: 'close', revision: rejected.revision },
    'PATCH',
  );
  await waitTask(rejected.id, (t) => t.container?.status === 'removed');
  console.log(
    'Docker pipeline: ten rounds, native IDs, quota, score retry, policy block, archive and cleanup passed',
  );
} finally {
  await stop(child);
  await api('/api/scheduler', original);
}
