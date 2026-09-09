import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { questionRoot, priorQuestionTurn } from '../lib/question-session.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
import { roundNumber } from '../lib/record-metadata.ts';
import { issues } from '../lib/pipeline.ts';
const hash = (b) => createHash('sha256').update(b).digest('hex');
test('Independent questions reset round number; only explicit continuation shares a root', () => {
  const a = { id: 'a', questionRootId: 'a', status: 'review' },
    b = { id: 'b', questionRootId: 'b', status: 'review' },
    c = { id: 'c', questionRootId: 'b', continuationOf: 'b' },
    t = { turns: [a, b, c] };
  assert.equal(questionRoot(t, a), 'a');
  assert.equal(questionRoot(t, b), 'b');
  assert.equal(questionRoot(t, c), 'b');
  assert.equal(questionRoot(t, { ...c, questionRootId: undefined }), 'b');
  assert.deepEqual(
    t.turns.map((r) => roundNumber(t, r)),
    [1, 1, 2],
  );
  assert.equal(priorQuestionTurn(t, b).id, 'a');
  assert.throws(
    () =>
      questionRoot(
        {
          turns: [
            { id: 'a', continuationOf: 'b' },
            { id: 'b', continuationOf: 'a' },
          ],
        },
        { id: 'a', continuationOf: 'b' },
      ),
    /循环/,
  );
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'question-snapshot-')),
    rt = new DockerRuntime(root),
    previous = {
      id: randomUUID(),
      status: 'review',
      permissionAudit: { passed: true },
    },
    turn = { id: randomUUID() },
    task = { id: randomUUID(), turns: [previous, turn] };
  const workDir = path.join(root, task.id, 'questions', turn.id, 'workspace'),
    evidence = path.join(root, task.id, previous.id + '.evidence');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(evidence, 'workspace'), { recursive: true });
  const data = '#!/bin/sh\necho inherited\n',
    manifest = {
      files: [{ name: 'workspace/run.sh', mode: 0o755, sha256: hash(data) }],
      omitted: [],
    };
  writeFileSync(path.join(evidence, 'workspace/run.sh'), data);
  const manifestPath = path.join(evidence, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    rt,
    task,
    turn,
    previous,
    manifest,
    manifestPath,
    evidence,
    s: {
      taskId: task.id,
      questionId: turn.id,
      workDir,
      status: 'running',
      bootstrapped: true,
    },
  };
}
test('New question imports frozen bytes, preserves executable bits and never reimports during continuation', () => {
  const f = fixture();
  f.rt.importPriorQuestion(f.s, f.task, f.turn);
  assert.equal(f.s.sourceSnapshot.sha256, hash(readFileSync(f.manifestPath)));
  assert.equal(f.s.sourceSnapshot.importedAfterStartup, true);
  const dest = path.join(f.s.workDir, 'run.sh');
  assert.equal(statSync(dest).mode & 0o777, 0o755);
  assert.match(readFileSync(dest, 'utf8'), /inherited/);
  writeFileSync(dest, 'modified');
  f.rt.importPriorQuestion(f.s, f.task, f.turn);
  assert.equal(readFileSync(dest, 'utf8'), 'modified');
});
test('Corrupt, oversized and escaping code snapshots stop import; interrupted copying can resume', () => {
  for (const kind of ['corrupt', 'omitted', 'escape']) {
    const f = fixture();
    if (kind === 'corrupt')
      writeFileSync(path.join(f.evidence, 'workspace/run.sh'), 'changed');
    if (kind === 'omitted')
      f.manifest.omitted = [{ name: 'large.bin', reason: '代码归档大小限制' }];
    if (kind === 'escape')
      f.manifest.files[0].name = 'workspace/../../escape.sh';
    writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    assert.throws(() => f.rt.importPriorQuestion(f.s, f.task, f.turn), /快照/);
  }
  const f = fixture();
  f.s.importing = hash(readFileSync(f.manifestPath));
  writeFileSync(path.join(f.s.workDir, 'run.sh'), 'partial');
  f.rt.importPriorQuestion(f.s, f.task, f.turn);
  assert.equal(f.s.importing, undefined);
  assert.match(
    readFileSync(path.join(f.s.workDir, 'run.sh'), 'utf8'),
    /inherited/,
  );
});
test('Later permission denial blocks earlier exports of that session, including excluded failures', () => {
  const first = {
      id: 'a',
      status: 'review',
      container: {},
      sessionId: 'same',
      review: {
        reviewer: 'Codex',
        source: 'codex',
        scores: [3, 3, 3, 3, 3],
        descriptions: ['a', 'b', 'c', 'd', 'e'],
        other: '',
      },
    },
    bad = {
      id: 'b',
      sessionId: 'same',
      permissionAudit: { passed: false },
      excluded: true,
    };
  assert.ok(
    issues({ turns: [first, bad], snapshot: '' }, first).some((x) =>
      x.includes('后续轨迹'),
    ),
  );
  assert.ok(
    !issues(
      { turns: [first, { ...bad, sessionId: 'different' }], snapshot: '' },
      first,
    ).some((x) => x.includes('后续轨迹')),
  );
});
