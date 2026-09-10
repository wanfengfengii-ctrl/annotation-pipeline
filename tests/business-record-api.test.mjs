// Isolated API/SQLite fixtures only. Never points at the live port or database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { base } from './fixtures/test-server.mjs';
import { gatewayRecordFixture } from './fixtures/gateway-record.mjs';
const root = fs.realpathSync(process.cwd());
assert.equal(
  path.basename(root),
  'gateway-api-test',
  'Only the owned isolated test directory is allowed',
);
const dbdir = path.join(
  root,
  '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
);
const files = fs
  .readdirSync(dbdir)
  .filter((n) => /^[a-f0-9]{64}\.sqlite$/.test(n));
assert.equal(files.length, 1);
const db = new DatabaseSync(path.join(dbdir, files[0]));
db.exec('PRAGMA busy_timeout=5000');
const runTag = randomUUID();
const saved = [],
  ids = [];
const api = async (route, body, method = 'POST') => {
  const r = await fetch(base + route, {
    method,
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return r;
};
const filter = {
  source: 'ai',
  query: '__BUSINESS_RECORD_API__' + runTag,
  page: '1',
  pageSize: '10',
};
const list = async (extra = {}) => {
  const r = await api(
    '/api/records?' + new URLSearchParams({ ...filter, ...extra }),
    null,
    'GET',
  );
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
};
const update = (t) =>
  db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(t), t.id);
try {
  for (let n = 0; n < 12; n++) {
    const f = gatewayRecordFixture(
      path.join(root, '.runner/record-fixtures', String(n)),
    );
    f.task.id = 'business-record-api-' + runTag + '-' + n;
    f.task.title = '__BUSINESS_RECORD_API__' + runTag + '-' + n;
    f.origin.prompt += '，记录组' + n;
    for (const r of f.task.turns) {
      r.container.taskId = f.task.id;
      if (r.gatewayContinuation) r.evaluationPrompt = f.origin.prompt;
      if (r.automation.submission)
        r.automation.submission.finalization.taskId = f.task.id;
    }
    const original = JSON.stringify(f.task);
    db.prepare(
      'INSERT INTO tasks(id,data,revision,created_at) VALUES(?,?,0,?)',
    ).run(f.task.id, original, f.origin.createdAt);
    db.prepare('INSERT OR IGNORE INTO project_names(task_id) VALUES(?)').run(
      f.task.id,
    );
    ids.push(f.task.id);
    saved.push({ f, original });
  }
  const data = await list();
  assert.equal(data.total, 12);
  assert.equal(data.rows.length, 10);
  assert.equal(data.totalPages, 2);
  assert.ok(
    data.rows.every(
      (r) =>
        r.turnId === 'first' &&
        r.resultTurnId === 'continue-2' &&
        r.values[0].includes('增加完整') &&
        r.values[2] === 'uuid-first' &&
        r.eligible,
    ),
  );
  const second = await list({ page: '2' });
  assert.equal(second.rows.length, 2);
  assert.equal(second.page, 2);
  assert.equal(
    (await list({ query: '继续' })).rows.filter((r) => ids.includes(r.taskId))
      .length,
    0,
  );
  assert.equal((await list({ query: '记录组11' })).total, 1);
  assert.equal((await list({ projectId: ids[0] })).total, 1);
  assert.equal((await list({ category: 'Bug 修复' })).total, 0);
  const selected = [...data.rows.slice(0, 1), ...second.rows.slice(0, 1)].map(
    ({ taskId, turnId }) => ({ taskId, turnId }),
  );
  const requestId = randomUUID(),
    body = {
      requestId,
      filter,
      scope: 'selected',
      selected,
      purpose: 'delivery',
      format: 'xlsx',
    };
  const response = await api('/api/export', body);
  assert.equal(response.status, 200, await response.clone().text());
  const bytes = Buffer.from(await response.arrayBuffer());
  const sheet = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']);
  assert.ok(sheet.includes('增加完整的记录管理功能'));
  assert.ok(!sheet.includes('>继续<'));
  assert.equal(response.headers.get('X-Export-Count'), '2');
  const replay = await api('/api/export', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), bytes);
  assert.equal((await list({ exports: 'exact', count: '1' })).total, 2);
  assert.equal((await list({ exports: 'never' })).total, 10);
  const bad = await api('/api/export', {
    ...body,
    requestId: randomUUID(),
    selected: [{ taskId: ids[0], turnId: 'continue-2' }],
  });
  assert.equal(bad.status, 400);
  for (const { f, original } of saved)
    assert.equal(
      db.prepare('SELECT data FROM tasks WHERE id=?').get(f.task.id).data,
      original,
    );
  const target = saved.find((s) => s.f.task.id === selected[0].taskId).f;
  target.result.automation.submission.finalization.traceExport.sha256 =
    '0'.repeat(64);
  update(target.task);
  assert.equal(
    (await api('/api/export', body)).status,
    400,
    'Old batch cannot silently acquire another trace',
  );
  const human = await api(
    '/api/tasks/' + ids[1] + '/human-review?turnId=first',
    null,
    'GET',
  );
  const review = await human.json();
  assert.equal(human.status, 200);
  assert.equal(review.turnId, 'first');
  assert.equal(review.resultTurnId, 'continue-2');
  assert.equal(review.promptId, 'uuid-first');
  assert.ok(review.originalAI);
  const meta = await api(
    '/api/tasks/' + ids[1],
    {
      revision: 0,
      action: 'record-metadata',
      turnId: 'continue-2',
      metadata: {
        parentRecord: 'parent',
        auditNote: '核对原题',
        parentRecord2: '',
      },
    },
    'PATCH',
  );
  assert.equal(meta.status, 200, await meta.clone().text());
  assert.equal(
    (await list({ projectId: ids[1] })).rows[0].values[28],
    '核对原题',
  );
  const broken = saved[2].f;
  broken.result.gatewayContinuation.failedPromptId = 'wrong';
  update(broken.task);
  const blocked = await list({ projectId: ids[2] });
  assert.ok(blocked.rows.length);
  assert.ok(blocked.rows.every((r) => !r.eligible && !r.reviewEligible));
  console.log(
    'Business records API: 12 projects/36 calls ->12 rows; multi-page selection/XLSX replay/count filters/root metadata/human source/frozen batch and malformed-chain rejection passed',
  );
} finally {
  for (const id of ids) {
    db.prepare('DELETE FROM export_items WHERE task_id=?').run(id);
    db.prepare('DELETE FROM project_names WHERE task_id=?').run(id);
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  }
  db.close();
}
