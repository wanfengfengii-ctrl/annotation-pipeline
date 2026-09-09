import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { roundNumber, updateRecordMetadata } from '../lib/record-metadata.ts';
import { recordRow, recordHeaders } from '../lib/record-fields.ts';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';

test('历史轮次保持位置，审核字段修改留痕且交付后锁定', () => {
  const r = {
      id: 'r2',
      status: 'review',
      prompt: 'demo',
      category: '代码理解',
      difficulty: '中等',
    },
    t = { id: 't', title: 'fixture', turns: [{ id: 'r1', excluded: true }, r] };
  assert.equal(roundNumber(t, r), 2);
  const values = {
    parentRecord: ' explicit parent ',
    auditNote: '=plain text',
    parentRecord2: 'second parent',
  };
  updateRecordMetadata(t, r, values);
  assert.equal(r.roundNumber, 2);
  assert.equal(r.metadataHistory.length, 1);
  assert.equal(r.metadataHistory[0].previous.auditNote, '');
  assert.equal(r.recordMetadata.parentRecord, 'explicit parent');
  updateRecordMetadata(t, r, values);
  assert.equal(r.metadataHistory.length, 1);
  const row = recordRow(t, { ...r, harness: 'Codex CLI' }, 'ai');
  assert.equal(row.values[7], 'Codex CLI');
  assert.deepEqual(row.values.slice(-3), [
    'explicit parent',
    '=plain text',
    'second parent',
  ]);
  assert.match(recordsCsv([row]), /'=plain text/);
  const xml = strFromU8(
    unzipSync(xlsx([row], 'batch'))['xl/worksheets/sheet1.xml'],
  );
  assert.ok(!xml.includes('<f>'));
  for (const lock of [
    { status: 'queued' },
    { status: 'running' },
    { receipt: 'receipt' },
    { humanReview: { receipt: 'human' } },
  ]) {
    assert.throws(
      () => updateRecordMetadata(t, { ...r, ...lock }, values),
      /不能修改/,
    );
  }
});
test('旧 26 列批次重新下载保留旧表头，新旧行混合拒绝导出', () => {
  const values = recordHeaders
    .map((_, i) => 'v' + i)
    .filter((_, i) => ![3, 27, 28, 29].includes(i));
  const row = {
    taskId: 't',
    turnId: 'r',
    provenance: 'AI',
    exportCount: 1,
    values,
  };
  const sheet = strFromU8(
    unzipSync(xlsx([row], 'old'))['xl/worksheets/sheet1.xml'],
  );
  assert.ok(!sheet.includes('当前对话轮次排序'));
  assert.match(sheet, /<c r="Z1"/);
  assert.ok(!sheet.includes('<c r="AA1"'));
  assert.equal(recordsCsv([row]).split('\r\n')[0].split(',').length, 26);
  assert.throws(
    () => xlsx([row, { ...row, values: Array(30).fill('') }], 'mixed'),
    /结构不一致/,
  );
});
