import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';
import {
  sanitizeExportRows,
  sanitizeExportCsv,
  exportSafetyHeaders,
} from '../lib/export-safety.mjs';

const credential = 'ghp_' + 'r'.repeat(30);
const row = (legacy = false) => ({
  taskId: 'task-id',
  turnId: 'turn-id',
  title: 'title',
  source: 'ai',
  exportCount: 4,
  provenance: 'reviewer alice@company.cn',
  eligible: true,
  ...(legacy ? {} : { formatVersion: 2 }),
  values: Array.from({ length: legacy ? 26 : 30 }, (_, i) =>
    i === 0 ? 'API_KEY=' + credential : i === 13 ? 4 : '',
  ),
  originalFields: {
    snapshot: 'snapshot',
    tracePath: '/traces/' + credential + '.jsonl',
    os: 'Linux',
    stack: 'contact 13800138000',
  },
});
test('safe copies cover every worksheet without changing scores, schema, counters or originals', () => {
  for (const legacy of [false, true]) {
    const original = [row(legacy)],
      before = JSON.stringify(original);
    const safe = sanitizeExportRows(original);
    const zip = unzipSync(xlsx(safe.rows, 'batch-id', safe.safety));
    const sheets = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].map(
      (p) => strFromU8(zip[p]),
    );
    assert.ok(
      sheets.every(
        (s) =>
          !s.includes(credential) &&
          !s.includes('alice@company.cn') &&
          !s.includes('13800138000'),
      ),
    );
    assert.ok(sheets[1].includes(safe.safety.version));
    assert.equal(safe.rows[0].values.length, legacy ? 26 : 30);
    assert.equal(safe.rows[0].values[13], 4);
    assert.equal(safe.rows[0].exportCount, 4);
    assert.equal(JSON.stringify(original), before);
    assert.equal(
      exportSafetyHeaders(safe.safety)['X-Export-Originals-Preserved'],
      'true',
    );
    assert.ok(!recordsCsv(safe.rows).includes(credential));
    assert.equal(sanitizeExportRows(safe.rows).safety.findings, 0);
  }
});
test('legacy CSV sanitizes decoded cells and preserves escaping, embedded newlines and formula defense', () => {
  const original = [row()];
  original[0].values[0] = 'description\n{"password":"hardsecret","note":"a,b"}';
  original[0].values[1] = '=1+1';
  const csv = recordsCsv(original);
  const safe = sanitizeExportCsv(csv);
  assert.ok(!safe.text.includes('hardsecret'));
  assert.ok(safe.text.includes('""password"":""[REDACTED_SECRET]""'));
  assert.ok(safe.text.includes('"\'=1+1"'));
  assert.equal(safe.text.split('\r\n').length, csv.split('\r\n').length);
  assert.equal(safe.text.split('\n').length, csv.split('\n').length);
  assert.equal(sanitizeExportCsv(safe.text).text, safe.text);
  assert.throws(() => sanitizeExportCsv('"unterminated'), /引号未闭合/);
});
test('saved snapshots are rescanned at download under current known secrets without rewriting history', () => {
  const secret = 'opaque-production-credential-value';
  const fixture = row(true);
  fixture.originalFields.snapshot = secret;
  const saved = JSON.stringify([fixture]);
  const rows = JSON.parse(saved);
  const safe = sanitizeExportRows(rows, { knownSecrets: [secret] });
  assert.ok(!JSON.stringify(safe.rows).includes(secret));
  assert.equal(JSON.stringify(rows), saved);
  assert.equal(safe.rows[0].exportCount, 4);
});
