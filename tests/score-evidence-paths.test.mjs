import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  verifyScoreEvidence,
  scoreEvidenceInstructions,
} from '../scripts/evidence.mjs';
import { sealStage, restoreStage } from '../scripts/stage-checkpoint.mjs';

test('deep question workspace cites original task evidence without relocating or guessing paths', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'score path ')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'questions', 'turn', 'workspace');
  mkdirSync(path.join(workDir, 'projects', 'project'), { recursive: true });
  const source = path.join(workDir, 'projects', 'project', 'app.js');
  const native = path.join(dir, 'turn.jsonl');
  const log = path.join(dir, 'turn.attempt-3.runtime', 'check.log');
  mkdirSync(path.dirname(log));
  writeFileSync(source, 'source\n');
  writeFileSync(native, '{"type":"user"}\r\n');
  writeFileSync(log, 'real check\npassed\n');
  const originals = [source, native, log].map((p) => readFileSync(p));
  const value = {
    scores: [4, 4, 3, 4, 5],
    descriptions: Array(5).fill('实际依据'),
    evidenceRefs: Array(5).fill(`${source}:1;${native}:1;${log}:2`),
  };
  const checked = verifyScoreEvidence(value, workDir, dir);
  assert.deepEqual(checked.evidenceRefs, value.evidenceRefs);
  for (const wrong of [
    '../turn.jsonl:1',
    '../../turn.attempt-3.runtime/check.log:2',
  ]) {
    assert.throws(
      () =>
        verifyScoreEvidence(
          { ...value, evidenceRefs: Array(5).fill(wrong) },
          workDir,
          dir,
        ),
      /评分引用文件不存在/,
    );
  }
  assert.throws(
    () =>
      verifyScoreEvidence(
        { ...value, evidenceRefs: Array(5).fill(`${log}:99`) },
        workDir,
        dir,
      ),
    /行号不存在/,
  );
  // Existing correctly based relative references remain valid, with no fallback search.
  verifyScoreEvidence(
    {
      ...value,
      evidenceRefs: Array(5).fill(
        'projects/project/app.js:1;../../../turn.jsonl:1',
      ),
    },
    workDir,
    dir,
  );
  const instructions = scoreEvidenceInstructions(workDir, dir);
  assert.ok(instructions.includes(JSON.stringify(workDir)));
  assert.ok(instructions.includes(JSON.stringify(dir)));
  const trace = path.join(dir, 'turn.attempt-4.score.events.jsonl');
  const output = trace.replace('.events.jsonl', '.json');
  writeFileSync(output, JSON.stringify(value));
  writeFileSync(
    trace,
    [
      { type: 'thread.started', thread_id: 'score' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(value) },
      },
      { type: 'turn.completed' },
    ]
      .map(JSON.stringify)
      .join('\n'),
  );
  const saved = {
    engine: 'codex-cli',
    threadId: 'score',
    finishedAt: '2026-09-11T00:00:00Z',
    tracePath: trace,
    value: checked,
  };
  const receipt = sealStage('score', saved, 'key', dir, [source, native, log]);
  assert.deepEqual(restoreStage('score', saved, receipt, 'key', dir), saved);
  [source, native, log].forEach((p, i) =>
    assert.deepEqual(readFileSync(p), originals[i]),
  );
  writeFileSync(log, 'changed\npassed\n');
  assert.equal(restoreStage('score', saved, receipt, 'key', dir), null);
});
