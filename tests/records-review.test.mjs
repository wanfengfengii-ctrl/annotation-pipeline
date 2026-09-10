import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { recordRow } from '../lib/record-fields.ts';
import { canExportRecord, exportPurpose } from '../lib/record-selection.ts';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';

import { reviewFixture } from './fixtures/review-record.mjs';

test('completed scores allow a review copy while final delivery remains blocked', () => {
  const { task, turn } = reviewFixture();
  const original = structuredClone({ task, turn });
  const row = recordRow(task, turn, 'ai');
  assert.equal(row.reviewEligible, true);
  assert.equal(row.eligible, false);
  assert.match(row.exportIssues.join('；'), /最终导出/);
  assert.equal(canExportRecord(row, 'review'), true);
  assert.equal(canExportRecord(row, 'delivery'), false);
  assert.deepEqual({ task, turn }, original);
  assert.equal(exportPurpose(undefined), 'delivery');
  assert.equal(exportPurpose('review'), 'review');
  assert.throws(() => exportPurpose('anything'));
  assert.equal(canExportRecord({ eligible: true }, 'review'), false);
});

test('incomplete scores, running records and excluded records cannot be selected as review copies', () => {
  for (const mutate of [
    (t) => {
      t.review.scores[0] = 0;
    },
    (t) => {
      t.review.descriptions[2] = '';
    },
    (t) => {
      t.status = 'running';
    },
    (t) => {
      t.excluded = true;
    },
  ]) {
    const { task, turn } = reviewFixture();
    mutate(turn);
    const row = recordRow(task, turn, 'ai');
    assert.equal(row.reviewEligible, false);
    assert.ok(row.reviewIssues.length);
  }
});

test('XLSX and CSV clearly label review copies, retain blocking reasons and never change originals', () => {
  const { task, turn } = reviewFixture();
  const row = { ...recordRow(task, turn, 'ai'), exportPurpose: 'review' };
  const original = structuredClone(row);
  const zip = unzipSync(xlsx([row], 'review-batch'));
  const main = strFromU8(zip['xl/worksheets/sheet1.xml']);
  const notes = strFromU8(zip['xl/worksheets/sheet2.xml']);
  assert.match(main, /复核副本（非正式交付）/);
  assert.match(main, /最终导出/);
  assert.match(notes, /正式交付待处理项/);
  assert.match(notes, /AI \/ Codex CLI，未经人工确认/);
  assert.match(recordsCsv([row]), /复核副本（非正式交付）/);
  assert.match(recordsCsv([row]), /最终导出/);
  assert.deepEqual(row, original);
  assert.deepEqual(turn.review.scores, [3, 4, 3, 4, 3]);
  assert.equal(row.eligible, false);
  assert.equal(row.values.length, 30);
});
