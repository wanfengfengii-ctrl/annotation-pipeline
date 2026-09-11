import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runtimePlanningContext } from '../scripts/runtime-planning-context.mjs';
const hash = (x) => createHash('sha256').update(x).digest('hex');
test('verified source differences guide navigation without reusing old test verdicts', (t) => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-navigation-')),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const manifestPath = path.join(dir, 'manifest.json');
  const bytes = JSON.stringify({
    files: [
      { name: 'workspace/app.js', sha256: hash('old') },
      { name: 'workspace/gone.js', sha256: hash('gone') },
    ],
  });
  fs.writeFileSync(manifestPath, bytes);
  const turn = { id: 'now' },
    task = {
      turns: [
        {
          id: 'before',
          automation: {
            archive: { manifestPath, manifestSha256: hash(bytes) },
          },
        },
        turn,
      ],
    };
  const files = [
    { path: 'app.js', sha256: hash('new') },
    { path: 'package.json', sha256: hash('package') },
  ];
  const context = runtimePlanningContext({ task, turn, dir, files });
  assert.deepEqual(context.changed, ['app.js', 'package.json']);
  assert.deepEqual(context.removed, ['gone.js']);
  assert.deepEqual(context.entryCandidates, ['app.js', 'package.json']);
  assert.equal(context.previousTurnId, 'before');
  assert.equal(context.passed, undefined);
  fs.writeFileSync(manifestPath, bytes + ' ');
  assert.equal(
    runtimePlanningContext({ task, turn, dir, files }).changed,
    null,
    'tampered history cannot narrow source review',
  );
});
