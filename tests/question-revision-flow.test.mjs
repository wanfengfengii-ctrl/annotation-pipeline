// Real runner against a fresh isolated API, with synthetic CLI/Terminal adapters.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  fixture,
  api,
  start,
  stop,
  waitTask,
  create,
  calls,
} from './fixtures/flow-helper.mjs';
const f = fixture('question-revision-flow', {
  FIXTURE_STOP_PROJECT: '1',
  FIXTURE_REJECT_WORDING_ONCE: '1',
});
const original = (await api('/api/scheduler', null, 'GET')).config;
let child;
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    repos: [],
    autoContinue: true,
    concurrency: 1,
  });
  const task = await create(f, '__WORDING_REVISION__');
  child = start(f);
  const t = await waitTask(task.id, (t) =>
    ['failed', 'review'].includes(t.turns[0].status),
  );
  const turn = t.turns[0];
  assert.equal(turn.status, 'review', turn.error + ' ' + f.errors);
  const count = (name) =>
    calls(f).filter(
      (e) => e.name === name && (name !== 'claude' || e.event === 'start'),
    ).length;
  assert.equal(count('prepare'), 2);
  assert.equal(count('policy'), 2);
  assert.equal(
    count('claude'),
    1,
    'only the re-audited prompt reaches Terminal',
  );
  assert.equal(turn.claudeAttempts.length, 1);
  assert.equal(turn.automation.policy.accepted, true);
  assert.ok(
    existsSync(turn.automation.questionRevision.rejectedAudit.tracePath),
  );
  assert.match(
    turn.automation.questionRevision.preparation.value.prompt,
    /处理结果可以回看和比较/,
  );
  assert.doesNotMatch(turn.prompt, /处理结果可以回看和比较/);
  assert.deepEqual(turn.automation.preparation.value.acceptance, [
    'fixture evidence',
  ]);
  const timing = readFileSync(turn.automation.timing.path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(new Set(timing.map((event) => event.attemptId)).size, 1);
  for (const event of ['attempt-start', 'attempt-end'])
    assert.equal(timing.filter((entry) => entry.event === event).length, 1);
  for (const stage of ['prepare', 'policy'])
    assert.equal(
      timing.filter(
        (entry) => entry.event === 'stage-start' && entry.stage === stage,
      ).length,
      2,
      'wording correction retains both stages in the same attempt',
    );
  console.log(
    'PASS: rejected unsent wording corrected once, audited again, original rejection preserved, one Terminal submission',
  );
} finally {
  await stop(child);
  await api('/api/scheduler', original);
}
