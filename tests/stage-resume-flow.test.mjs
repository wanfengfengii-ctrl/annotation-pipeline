// Real runner + isolated API; synthetic model and Docker responses only.
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
const f = fixture('stage-resume-flow', {
  FIXTURE_STOP_PROJECT: '1',
  FIXTURE_DELAY_STAGE: 'delivery',
});
const original = (await api('/api/scheduler', null, 'GET')).config;
let child;
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    useHistory: false,
    repos: [],
    autoContinue: true,
    concurrency: 1,
  });
  writeFileSync(path.join(f.bin, 'fail-delivery-once'), '1');
  const task = await create(f, '__DOCKER_TEN_ROUNDS__');
  child = start(f);
  let t = await waitTask(task.id, (t) => t.turns[0].status === 'failed');
  assert.equal(t.turns[0].stage, 'delivery', t.turns[0].error + ' ' + f.errors);
  const retry = async () => {
    await api(
      '/api/tasks/' + t.id,
      { action: 'retry', turnId: t.turns[0].id, revision: t.revision },
      'PATCH',
    );
  };
  writeFileSync(path.join(f.bin, 'fail-delivery-once'), '1');
  await retry();
  t = await waitTask(task.id, (t) => t.turns[0].status === 'failed');
  assert.equal(t.turns[0].stage, 'delivery', t.turns[0].error + ' ' + f.errors);
  await retry();
  await waitTask(
    task.id,
    (t) => t.turns[0].status === 'running' && t.turns[0].stage === 'delivery',
  );
  child.kill('SIGUSR2');
  t = await waitTask(task.id, (t) => t.turns[0].status === 'review');
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(
      () => reject(Error('drain did not finish')),
      10000,
    );
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  assert.equal(child.exitCode, 0, 'graceful drain completes current delivery');
  const count = (name) =>
    calls(f).filter(
      (e) => e.name === name && (name !== 'claude' || e.event === 'start'),
    ).length;
  assert.equal(count('claude'), 1, 'no duplicate native question');
  assert.equal(count('policy'), 1, 'completed pre-run approval reused');
  assert.equal(count('runtime-plan'), 1, 'completed runtime evidence reused');
  assert.equal(count('score'), 1, 'delivery interruption must not re-score');
  assert.equal(count('delivery'), 3, 'only failed stage retried');
  assert.ok(t.turns[0].automation.archive);
  assert.equal(
    t.turns[0].automation.stageReuse.score.inputsAndEvidenceVerified,
    true,
  );
  assert.equal(t.turns[0].claudeAttempts.length, 1);
  console.log(
    'PASS: two delivery interruptions => one Claude, policy, runtime and score; only delivery repeats',
  );
} finally {
  await stop(child);
  await api('/api/scheduler', original);
}
