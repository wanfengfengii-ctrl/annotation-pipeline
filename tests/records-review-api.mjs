// Run against the isolated seeded fixture on port 3001, never production.
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { base } from './fixtures/test-server.mjs';
const filter = { source: 'ai', query: '复核样例项目', page: 1, pageSize: 10 };
const records = async (extra = {}) =>
  (
    await fetch(
      base + '/api/records?' + new URLSearchParams({ ...filter, ...extra }),
    )
  ).json();
const send = (body) =>
  fetch(base + '/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const before = await records();
assert.equal(before.total, 12);
assert.ok(before.rows.every((r) => r.reviewEligible && !r.eligible));
const second = await records({ page: 2 });
const selected = [before.rows[0], second.rows[0]].map(({ taskId, turnId }) => ({
  taskId,
  turnId,
}));
const input = {
  requestId: crypto.randomUUID(),
  filter,
  format: 'xlsx',
  scope: 'selected',
  selected,
};
assert.equal(
  (await send(input)).status,
  400,
  'omitting purpose keeps the strict delivery gate',
);
assert.equal((await records({ exports: 'never' })).total, 12);
const copy = { ...input, purpose: 'review' };
const response = await send(copy);
assert.equal(response.status, 200, await response.clone().text());
assert.equal(response.headers.get('X-Export-Count'), '2');
assert.equal(response.headers.get('X-Export-Purpose'), 'review');
const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
assert.match(
  strFromU8(zip['xl/worksheets/sheet1.xml']),
  /复核副本（非正式交付）/,
);
assert.match(strFromU8(zip['xl/worksheets/sheet2.xml']), /最终导出/);
assert.equal((await send(copy)).status, 200, 'retry reuses the same batch');
assert.equal((await records({ exports: 'exact', count: 1 })).total, 2);
assert.equal(
  (await send(input)).status,
  400,
  'review request ID cannot become a delivery request',
);
assert.equal((await send({ ...copy, purpose: 'invalid' })).status, 400);
assert.equal(
  (
    await send({
      ...copy,
      requestId: crypto.randomUUID(),
      selected: [...selected, { taskId: 'missing', turnId: 'missing' }],
    })
  ).status,
  400,
);
assert.equal((await records({ exports: 'exact', count: 1 })).total, 2);
const csv = await send({
  ...copy,
  requestId: crypto.randomUUID(),
  format: 'csv',
});
assert.equal(csv.status, 200);
assert.match(await csv.text(), /复核副本（非正式交付）.*最终导出/);
assert.equal((await records({ exports: 'exact', count: 2 })).total, 2);
assert.equal((await records({ exports: 'never' })).total, 10);
const after = await records();
assert.deepEqual(
  after.rows.map((r) => r.values),
  before.rows.map((r) => r.values),
);
assert.ok(
  after.rows.every((r) => !r.eligible),
  'review exports never make records eligible for SOLO',
);
console.log(
  'Review API passed: cross-page selection, strict delivery, XLSX/CSV labels, immutable scores, request-purpose isolation and exact idempotent counts.',
);
