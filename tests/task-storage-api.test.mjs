// Real Worker/D1 API regression, restricted to an isolated fixture checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { parseTask } from '../lib/task-storage.mjs';
import { gatewayRecordFixture } from './fixtures/gateway-record.mjs';
import { base } from './fixtures/test-server.mjs';

const root = fs.realpathSync(process.cwd());
assert.equal(path.basename(root), 'gateway-api-test');
const dir = path.join(root, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
const files = fs
  .readdirSync(dir)
  .filter((n) => /^[a-f0-9]{64}\.sqlite$/.test(n));
assert.equal(files.length, 1);
const db = new DatabaseSync(path.join(dir, files[0]));
db.exec('PRAGMA busy_timeout=5000');
const f = gatewayRecordFixture(
  path.join(root, '.runner/storage-fixture', randomUUID()),
);
f.task.id = 'storage-api-' + randomUUID();
f.task.title = '__TASK_STORAGE_API__';
for (const r of f.task.turns) {
  r.container.taskId = f.task.id;
  if (r.automation.submission)
    r.automation.submission.finalization.taskId = f.task.id;
}
f.task.storagePadding = '';
f.task.storagePadding = 'x'.repeat(
  2097152 - 1200 - Buffer.byteLength(JSON.stringify(f.task)),
);
const original = JSON.stringify(f.task);
const api = (route, body, method = 'POST') =>
  fetch(base + route, {
    method,
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
try {
  db.prepare(
    'INSERT INTO tasks(id,data,revision,created_at) VALUES(?,?,0,?)',
  ).run(f.task.id, original, f.origin.createdAt);
  db.prepare('INSERT OR IGNORE INTO project_names(task_id) VALUES(?)').run(
    f.task.id,
  );
  const body = {
    revision: 0,
    action: 'record-metadata',
    turnId: 'continue-2',
    metadata: {
      parentRecord: '',
      auditNote: '验收'.repeat(1000),
      parentRecord2: '',
    },
  };
  const update = await api('/api/tasks/' + f.task.id, body, 'PATCH');
  assert.equal(update.status, 200, await update.text());
  const saved = db
    .prepare('SELECT data,revision FROM tasks WHERE id=?')
    .get(f.task.id);
  assert.equal(saved.revision, 1);
  assert.ok(Buffer.byteLength(saved.data) < 2097152);
  const task = parseTask(saved.data);
  assert.ok(Buffer.byteLength(JSON.stringify(task)) > 2097152);
  assert.equal(task.storagePadding, f.task.storagePadding);
  assert.deepEqual(task.turns.at(-1).review, f.result.review);
  assert.equal(task.turns[0].prompt, f.origin.prompt);
  assert.equal(
    (await api('/api/tasks/' + f.task.id, body, 'PATCH')).status,
    400,
  );
  assert.equal(
    db.prepare('SELECT revision FROM tasks WHERE id=?').get(f.task.id).revision,
    1,
  );
  const response = await api('/api/tasks', null, 'GET');
  assert.equal(response.status, 200);
  const publicTask = (await response.json()).tasks.find(
    (t) => t.id === f.task.id,
  );
  assert.equal(publicTask.storagePadding, f.task.storagePadding);
  assert.equal(publicTask.__annotationTaskStorage, undefined);
  const filter = {
    source: 'ai',
    projectId: f.task.id,
    page: '1',
    pageSize: '10',
  };
  const list = async (extra = {}) => {
    const r = await api(
      '/api/records?' + new URLSearchParams({ ...filter, ...extra }),
      null,
      'GET',
    );
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const records = await list();
  assert.equal(records.total, 1);
  assert.equal(records.rows[0].turnId, 'first');
  assert.equal(records.rows[0].values[28], body.metadata.auditNote);
  const exportRequest = {
    requestId: randomUUID(),
    filter,
    scope: 'selected',
    selected: [{ taskId: f.task.id, turnId: 'first' }],
    purpose: 'delivery',
    format: 'xlsx',
  };
  const exported = await api('/api/export', exportRequest);
  assert.equal(exported.status, 200, await exported.clone().text());
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.ok(
    strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']).includes(
      '增加完整的记录管理功能',
    ),
  );
  const replay = await api('/api/export', exportRequest);
  assert.equal(replay.status, 200);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), bytes);
  assert.equal((await list({ exports: 'exact', count: '1' })).total, 1);
  assert.equal((await list({ exports: 'never' })).total, 0);
  console.log(
    'Task storage Worker/D1: >2 MiB update, exact history, stale revision, decoded GET, record filters, selected XLSX and frozen replay passed',
  );
} finally {
  db.prepare('DELETE FROM export_items WHERE task_id=?').run(f.task.id);
  db.prepare('DELETE FROM project_names WHERE task_id=?').run(f.task.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(f.task.id);
  db.close();
}
