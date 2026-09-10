import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blockUpload,
  uploadHolds,
  applyUploadHolds,
  assertUploadNotHeld,
} from '../scripts/solo-upload-holds.mjs';

test('禁止上传按固定记录 ID 生效，跨排序保留且不更改原题、评分或已有回执', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-holds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = {
    entries: { 'task:other': { remoteId: 618, state: 'submitted' } },
  };
  fs.writeFileSync(path.join(root, 'ui-state.json'), JSON.stringify(ledger));
  const rows = [
    { taskId: 'task', turnId: 'held', eligible: true, values: ['原题', 4] },
    { taskId: 'task', turnId: 'other', eligible: true, values: ['另一题', 3] },
  ];
  await blockUpload('task:held', '用户指定本条不上传', root);
  const output = applyUploadHolds([...rows].reverse(), root);
  assert.equal(output[0].eligible, true);
  assert.equal(output[1].eligible, false);
  assert.deepEqual(output[1].values, rows[0].values);
  assert.equal(rows[0].eligible, true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'ui-state.json'))),
    ledger,
  );
  assert.throws(() => assertUploadNotHeld(rows[0], root), /用户已标记禁止上传/);
  assert.doesNotThrow(() => assertUploadNotHeld(rows[1], root));
  assert.equal(uploadHolds(root).entries['task:held'].blocked, true);
});

test('提交结果不明时先核对回执，损坏标记不会默认为允许上传', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-holds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'ui-state.json'),
    JSON.stringify({ entries: { 'task:turn': { state: 'uncertain' } } }),
  );
  await assert.rejects(
    blockUpload('task:turn', '不上传', root),
    /提交结果尚未明确/,
  );
  assert.equal(fs.existsSync(path.join(root, 'journal.lock')), false);
  await assert.rejects(blockUpload('../unsafe', '不上传', root), /固定记录 ID/);
  fs.writeFileSync(
    path.join(root, 'upload-holds.json'),
    JSON.stringify({
      version: 1,
      entries: { 'task:turn': { blocked: false, reason: '损坏标记' } },
    }),
  );
  assert.throws(
    () =>
      applyUploadHolds(
        [{ taskId: 'task', turnId: 'turn', eligible: true }],
        root,
      ),
    /标记无效/,
  );
});
