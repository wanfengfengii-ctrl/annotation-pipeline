// Synthetic API fixtures only. Stop the real runner and use an empty queue.
import assert from 'node:assert/strict';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
const ids = [],
  batches = [];
async function request(route, body, method = 'POST', auth = false) {
  return fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function api(route, body, method = 'POST', auth = false) {
  const r = await request(route, body, method, auth);
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const run = (b) => api('/api/runner', b, 'POST', true);
const original = (await api('/api/scheduler', null, 'GET')).config;
const latest = async (id) =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
const filter = {
  source: 'ai',
  query: '__RECORDS_API__',
  exports: 'all',
  page: 1,
  pageSize: 10,
};
const records = (f) =>
  api('/api/records?' + new URLSearchParams({ ...filter, ...f }), null, 'GET');
async function exportFile(
  f = filter,
  scope = 'filtered',
  id = crypto.randomUUID(),
  format = 'xlsx',
) {
  batches.push(id);
  writeFileSync(
    '.runner/records-export-batches',
    JSON.stringify([...new Set(batches)]),
  );
  return request('/api/export', { requestId: id, filter: f, scope, format });
}
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    autoContinue: false,
    concurrency: 1,
  });
  for (let i = 0; i < 12; i++) {
    const { task } = await api('/api/tasks', {
      title: '__RECORDS_API__' + i,
      repoPath: '/tmp/records-fixture',
      category: '0-1 代码生成',
      difficulty: '困难',
      stack: 'TypeScript',
      reproducibility: '无外部依赖',
      projectSeries: true,
      autoStart: true,
    });
    ids.push(task.id);
    writeFileSync('.runner/records-api-ids', JSON.stringify(ids));
    let { job } = await run({ action: 'claim', capacity: 1 });
    assert.equal(job.task.id, task.id);
    const sessionId = 'records-session-' + i;
    const container = {
      taskId: task.id,
      name: 'annotation-' + task.id,
      policyVersion: containerPolicyVersion,
      status: 'running',
      image: containerImage,
      imageId: 'sha256:' + 'a'.repeat(64),
      snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
      workDir: '/fixture/' + task.id + '/workspace',
    };
    await run({ action: 'container', taskId: task.id, container });
    const finish = (extra) =>
      run({
        action: 'finish',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        container,
        traceExport: {
          verified: true,
          path: '/fixture/projects',
          files: 1,
          sha256: 'a'.repeat(64),
        },
        ...extra,
      });
    for (let n = 1; n <= (i === 0 ? 10 : 1); n++) {
      await run({
        action: 'stage',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        stage: 'claude',
      });
      const reserve = {
        action: 'reserve-claude',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        sessionId,
        attemptId: 'attempt-' + n,
      };
      assert.deepEqual(await run(reserve), { allowed: true, count: n });
      assert.deepEqual(
        await run(reserve),
        { allowed: true, count: n },
        'reservation retry must be idempotent',
      );
      await assert.rejects(
        () => run({ ...reserve, sessionId: 'different' }),
        /切换/,
      );
      if (i === 0 && n < 10) {
        await finish({
          success: false,
          sessionId,
          error: 'synthetic failed call',
        });
        const t = await latest(task.id);
        await api(
          '/api/tasks/' + task.id,
          { action: 'retry', turnId: job.turn.id, revision: t.revision },
          'PATCH',
        );
        ({ job } = await run({ action: 'claim', capacity: 1 }));
      }
    }
    if (i === 0) {
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, j) =>
          run({
            action: 'reserve-claude',
            taskId: task.id,
            turnId: job.turn.id,
            jobToken: job.turn.jobToken,
            sessionId,
            attemptId: 'over-cap-' + j,
          }),
        ),
      );
      assert.ok(results.every((r) => !r.allowed && r.count === 10));
    }
    await assert.rejects(
      () => finish({ success: true, contextCheck: { ready: false } }),
      /上下文/,
    );
    await finish({
      success: true,
      sessionId,
      promptId: 'records-prompt-' + i,
      preparedPrompt: '=1+1\n中文<&" ' + i,
      tracePath: '/fixture/trajectory-' + i,
      snapshot: container.snapshot,
      harnessVersion: 'fixture-2.1',
      os: 'macOS',
      review: {
        source: 'codex',
        scores: [1, 2, 3, 4, 5],
        descriptions: [
          '交付观察',
          '指令观察',
          '规划观察',
          '推理观察',
          '执行观察',
        ],
        other: '无',
      },
      automation: {
        bundlePath: '/fixture/bundle',
        delivery: { value: { passed: true } },
      },
    });
    if (i === 0) {
      const t = await latest(task.id);
      assert.equal(t.turns[0].claudeAttempts.length, 10);
      await assert.rejects(
        () =>
          api(
            '/api/tasks/' + task.id,
            {
              action: 'enqueue',
              revision: t.revision,
              prompt: 'eleventh',
              category: 'Feature 迭代',
              difficulty: '困难',
            },
            'PATCH',
          ),
        /10/,
      );
    }
  }
  let edited = await latest(ids[1]);
  const metadata = {
    parentRecord: 'external-1',
    auditNote: '人工核对日期字段',
    parentRecord2: '',
  };
  const metadataBody = {
    action: 'record-metadata',
    turnId: edited.turns[0].id,
    metadata,
    revision: edited.revision,
  };
  await api('/api/tasks/' + edited.id, metadataBody, 'PATCH');
  await assert.rejects(
    () => api('/api/tasks/' + edited.id, metadataBody, 'PATCH'),
    /数据已更新/,
  );
  edited = await latest(edited.id);
  assert.equal(edited.turns[0].metadataHistory.length, 1);
  let data = await records({});
  assert.equal(data.total, 12);
  assert.equal(data.rows.length, 10);
  assert.equal(data.headers.length, 30);
  assert.ok(data.rows.every((r) => r.eligible));
  assert.ok(data.rows.every((r) => r.values[3] === 1));
  const editedRow = await records({ query: '__RECORDS_API__1', pageSize: 20 });
  assert.deepEqual(
    editedRow.rows.find((r) => r.taskId === edited.id).values.slice(-3),
    ['external-1', '人工核对日期字段', ''],
  );
  const page2 = await records({ page: 2 });
  assert.equal(page2.rows.length, 2);
  assert.ok(
    !page2.rows.some((r) => data.rows.some((a) => a.turnId === r.turnId)),
  );
  assert.equal((await records({ page: 999 })).page, 2);
  assert.equal((await records({ category: 'Bug 修复' })).total, 0);
  assert.equal((await records({ query: "' OR 1=1 --" })).total, 0);
  const id = crypto.randomUUID(),
    first = await exportFile(filter, 'page', id);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get('X-Export-Count'), '10');
  const bytes = new Uint8Array(await first.arrayBuffer());
  writeFileSync('.runner/records-fixture.xlsx', bytes);
  const again = await exportFile(filter, 'page', id);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('X-Export-Count'), '10');
  assert.equal((await records({ exports: 'exact', count: 1 })).total, 10);
  assert.equal((await records({ exports: 'never' })).total, 2);
  assert.equal(
    (await exportFile({ ...filter, category: 'Bug 修复' }, 'page', id)).status,
    400,
  );
  const id2 = crypto.randomUUID(),
    concurrent = await Promise.all([
      exportFile({ ...filter, exports: 'never' }, 'filtered', id2),
      exportFile({ ...filter, exports: 'never' }, 'filtered', id2),
    ]);
  assert.ok(concurrent.every((r) => r.status === 200));
  assert.ok(concurrent.every((r) => r.headers.get('X-Export-Count') === '2'));
  assert.equal((await records({ exports: 'exact', count: 1 })).total, 12);
  const all = await exportFile(filter, 'filtered', crypto.randomUUID(), 'csv');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('X-Export-Count'), '12');
  assert.ok((await all.text()).startsWith('"User Prompt","SessionID"'));
  assert.equal((await records({ exports: 'exact', count: 2 })).total, 12);
  assert.equal((await records({ exports: 'never' })).total, 0);
  assert.equal((await exportFile({ ...filter, exports: 'never' })).status, 400);
  assert.equal((await records({ exports: 'exact', count: 2 })).total, 12);
  console.log(
    'Records API passed: 30 fields, 12 records on two pages, exact filters, XLSX/CSV, export scope, idempotent concurrent retries, ten-call failure budget and session lock.',
  );
} finally {
  await api('/api/scheduler', original);
}
