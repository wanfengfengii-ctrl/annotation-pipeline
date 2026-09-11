import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { recoveryFiles } from '../scripts/recovery.mjs';

test('startup scans only canonical task receipts and journals, excluding historical backups and links', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'recovery-spool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = '11111111-1111-1111-1111-111111111111',
    turn = '22222222-2222-2222-2222-222222222222';
  for (const dir of [
    task,
    'historical-validation-20260911',
    'validation-recovery-20260911',
  ]) {
    mkdirSync(path.join(root, dir));
    for (const kind of ['result', 'job'])
      writeFileSync(path.join(root, dir, turn + '.' + kind + '.json'), '{}');
  }
  writeFileSync(path.join(root, task, turn + '.old.result.json'), '{}');
  writeFileSync(path.join(root, task, turn + '.result.json.delivered'), 'old');
  symlinkSync(
    path.join(root, task),
    path.join(root, '33333333-3333-3333-3333-333333333333'),
  );
  symlinkSync(
    path.join(root, task, turn + '.result.json'),
    path.join(root, task, '44444444-4444-4444-4444-444444444444.result.json'),
  );
  for (const kind of ['result', 'job'])
    assert.deepEqual(recoveryFiles(root, kind), [
      path.join(root, task, turn + '.' + kind + '.json'),
    ]);
});
