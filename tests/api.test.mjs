import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
import { base } from './fixtures/test-server.mjs';
async function call(route, body, method = 'POST', auth = false) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const draft = {
  title: '__PIPELINE_API_TEST__',
  repoPath: '/tmp/pipeline-api-test',
  stack: 'test',
  category: 'Feature 迭代',
  difficulty: '中等',
  reproducibility: '无外部依赖',
};
assert.equal(
  (await call('/api/tasks', { ...draft, difficulty: '简单' })).status,
  400,
);
assert.equal((await call('/api/runner', { action: 'claim' })).status, 400);
const {
  data: { task },
} = await call('/api/tasks', draft);
writeFileSync('.runner/api-test-id', task.id);
async function latest() {
  return (await call('/api/tasks', null, 'GET')).data.tasks.find(
    (x) => x.id === task.id,
  );
}
let t = await latest();
const edit = (body) =>
  call('/api/tasks/' + task.id, { ...body, revision: t.revision }, 'PATCH');
assert.equal(
  (
    await edit({
      action: 'enqueue',
      prompt: 'test prompt',
      category: 'Feature 迭代',
      difficulty: '中等',
    })
  ).status,
  200,
);
assert.equal(
  (
    await edit({
      action: 'enqueue',
      prompt: 'stale',
      category: 'Feature 迭代',
      difficulty: '中等',
    })
  ).status,
  400,
);
t = await latest();
assert.equal(
  (
    await edit({
      action: 'enqueue',
      prompt: 'duplicate',
      category: 'Feature 迭代',
      difficulty: '中等',
    })
  ).status,
  400,
);
for (let n = 1; n <= 10; n++) {
  const {
    data: { job },
  } = await call('/api/runner', { action: 'claim' }, 'POST', true);
  assert.ok(job);
  assert.equal(
    (await call('/api/runner', { action: 'claim' }, 'POST', true)).data.job,
    null,
  );
  assert.equal(
    (
      await call(
        '/api/runner',
        {
          action: 'finish',
          taskId: task.id,
          turnId: job.turn.id,
          jobToken: 'wrong',
          success: true,
        },
        'POST',
        true,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        '/api/runner',
        {
          action: 'finish',
          taskId: task.id,
          turnId: job.turn.id,
          jobToken: job.turn.jobToken,
          success: true,
          output: 'Synthetic API test only',
          sessionId: 'synthetic-session',
          promptId: 'synthetic-prompt-' + n,
          tracePath: '/synthetic/trace',
          snapshot: 'https://github.com/test/test/commit/' + 'a'.repeat(40),
          harnessVersion: 'test',
          os: 'test',
        },
        'POST',
        true,
      )
    ).status,
    200,
  );
  t = await latest();
  assert.ok(t.turns.every((r) => !r.jobToken));
  if (n === 1) {
    assert.equal(
      (await edit({ action: 'submit', turnId: job.turn.id, receipt: 'test' }))
        .status,
      400,
    );
    assert.equal(
      (
        await edit({
          action: 'review',
          turnId: job.turn.id,
          review: {
            scores: [5, 5, 5, 5, 5],
            descriptions: ['test', 'test', 'test', 'test', 'test'],
            reviewer: 'synthetic-test',
            attested: true,
            other: '',
          },
        })
      ).status,
      200,
    );
    t = await latest();
    assert.equal(
      (
        await edit({
          action: 'submit',
          turnId: job.turn.id,
          receipt: 'SYNTHETIC TEST RECEIPT',
        })
      ).status,
      200,
    );
    t = await latest();
    assert.equal(
      (await edit({ action: 'review', turnId: job.turn.id, review: {} }))
        .status,
      400,
    );
  }
  if (n < 10) {
    t = await latest();
    assert.equal(
      (
        await edit({
          action: 'enqueue',
          prompt: 'synthetic-' + n,
          category: 'Bug 修复',
          difficulty: '简单',
        })
      ).status,
      200,
    );
  }
}
t = await latest();
assert.equal(
  (
    await edit({
      action: 'enqueue',
      prompt: 'round11',
      category: 'Bug 修复',
      difficulty: '中等',
    })
  ).status,
  400,
);
const exportText = await (await fetch(base + '/api/export')).text();
assert.ok(exportText.includes('SYNTHETIC') === false);
assert.ok(exportText.includes('synthetic-prompt-1'));
assert.equal(exportText.split('\r\n').length, 2);
console.log(
  'API integration passed: create, classify, CAS conflict, single execution, job authentication, exact ten-turn cap, scoring, locked submission, filtered CSV',
);
