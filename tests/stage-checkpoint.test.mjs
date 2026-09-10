import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realpathSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sealStage,
  restoreStage,
  checkpointDigest,
} from '../scripts/stage-checkpoint.mjs';

test('only unchanged inputs, validated result and completed stage evidence can resume', () => {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'stage-checkpoint-')),
  );
  try {
    const trace = path.join(dir, 'turn.attempt-1.score.events.jsonl'),
      output = path.join(dir, 'turn.attempt-1.score.json');
    const value = { scores: [3, 4, 4, 3, 4] };
    const events = [
      { type: 'thread.started', thread_id: 'thread' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: JSON.stringify(value) },
      },
      { type: 'turn.completed' },
    ];
    writeFileSync(trace, events.map(JSON.stringify).join('\n') + '\n');
    writeFileSync(output, JSON.stringify(value));
    const saved = {
      value,
      engine: 'codex-cli',
      threadId: 'thread',
      tracePath: trace,
      finishedAt: '2026-09-10T00:00:00Z',
    };
    const key = checkpointDigest({
        prompt: '原题',
        source: 'hash1',
        runtime: 'hash2',
        rubric: 'v1',
      }),
      receipt = sealStage('score', saved, key, dir);
    assert.deepEqual(restoreStage('score', saved, receipt, key, dir), saved);
    assert.equal(
      restoreStage(
        'score',
        saved,
        receipt,
        checkpointDigest({ prompt: '新题' }),
        dir,
      ),
      null,
    );
    assert.equal(
      restoreStage(
        'score',
        { ...saved, value: { scores: [5, 5, 5, 5, 5] } },
        receipt,
        key,
        dir,
      ),
      null,
    );
    writeFileSync(output, JSON.stringify({ scores: [5, 5, 5, 5, 5] }));
    assert.equal(restoreStage('score', saved, receipt, key, dir), null);
    writeFileSync(output, JSON.stringify(value));
    const originalTrace = path.join(
      dir,
      'turn.attempt-1.original.score.events.jsonl',
    );
    const originalOutput = originalTrace.replace('.events.jsonl', '.json');
    writeFileSync(originalTrace, events.map(JSON.stringify).join('\n'));
    writeFileSync(originalOutput, JSON.stringify(value));
    const reviewed = {
      ...saved,
      consistencyRevision: { originalTracePaths: [originalTrace] },
    };
    const reviewReceipt = sealStage('score', reviewed, key, dir);
    assert.deepEqual(
      restoreStage('score', reviewed, reviewReceipt, key, dir),
      reviewed,
    );
    writeFileSync(originalOutput, JSON.stringify({ scores: [5, 5, 5, 5, 5] }));
    assert.equal(
      restoreStage('score', reviewed, reviewReceipt, key, dir),
      null,
    );
    writeFileSync(trace, events.slice(0, -1).map(JSON.stringify).join('\n'));
    assert.equal(restoreStage('score', saved, receipt, key, dir), null);
    writeFileSync(trace, events.map(JSON.stringify).join('\n'));
    rmSync(output);
    symlinkSync(trace, output);
    assert.equal(restoreStage('score', saved, receipt, key, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing legacy receipts and changed rules fail closed', () => {
  assert.equal(
    restoreStage('policy', { accepted: true }, undefined, 'new-rules', '/tmp'),
    null,
  );
});

test('changed cited bytes invalidate score and its dependent delivery even when scores stay identical', () => {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'stage-citation-')),
  );
  try {
    const reference = path.join(dir, 'extra.log');
    writeFileSync(reference, 'before\n');
    const trace = path.join(dir, 'turn.attempt-1.score.events.jsonl'),
      output = path.join(dir, 'turn.attempt-1.score.json');
    const value = { scores: [3, 4, 4, 3, 4] },
      saved = {
        value,
        engine: 'codex-cli',
        threadId: 'thread',
        tracePath: trace,
        finishedAt: '2026-09-10T00:00:00Z',
      };
    writeFileSync(output, JSON.stringify(value));
    writeFileSync(
      trace,
      [
        { type: 'thread.started', thread_id: 'thread' },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(value) },
        },
        { type: 'turn.completed' },
      ]
        .map(JSON.stringify)
        .join('\n'),
    );
    const original = sealStage('score', saved, 'input', dir, [reference]);
    const deliveryKey = checkpointDigest({ scoreCheckpoint: original });
    writeFileSync(reference, 'after!\n'); // same number of bytes and lines
    assert.equal(restoreStage('score', saved, original, 'input', dir), null);
    const revalidated = sealStage('score', saved, 'input', dir, [reference]);
    assert.notEqual(
      checkpointDigest({ scoreCheckpoint: revalidated }),
      deliveryKey,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
