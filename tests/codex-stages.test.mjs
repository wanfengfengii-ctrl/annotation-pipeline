import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStage } from '../scripts/codex-stages.mjs';
import { issues, csv } from '../lib/pipeline.ts';
test('Codex structured stage validation rejects malformed scores', () => {
  assert.throws(() =>
    validateStage('score', {
      scores: [5, 5, 5, 5, 6],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
      other: '无',
    }),
  );
  assert.throws(() =>
    validateStage('score', { scores: [5], descriptions: ['a'], other: '无' }),
  );
  assert.throws(() =>
    validateStage('prepare', {
      prompt: 'x',
      category: 'invented',
      difficulty: '中等',
      stack: 'Go',
      acceptance: ['x'],
    }),
  );
  assert.equal(
    validateStage('delivery', {
      passed: false,
      checks: ['缺少证据'],
      summary: '未通过',
    }).passed,
    false,
  );
});
test('AI ratings require delivery verification and retain provenance in export', () => {
  const review = {
    source: 'codex',
    attested: false,
    reviewer: 'Codex CLI',
    scores: [3, 3, 3, 3, 3],
    descriptions: ['a', 'b', 'c', 'd', 'e'],
    other: '无',
  };
  const r = {
    status: 'review',
    createdAt: new Date().toISOString(),
    prompt: 'goal',
    category: 'Feature 迭代',
    difficulty: '中等',
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/trace',
    review,
  };
  const t = {
    title: 'AI test',
    snapshot: 'https://github.com/a/b/commit/' + 'a'.repeat(40),
    harnessVersion: 'v',
    os: 'macOS',
    turns: [r],
  };
  assert.equal(issues(t, r).length, 1);
  r.automation = {
    delivery: { value: { passed: true } },
    bundlePath: '/bundle',
  };
  assert.deepEqual(issues(t, r), []);
  assert.match(csv([t]), /AI \/ Codex CLI/);
  assert.match(csv([t]), /不作为原项目人工标注/);
  assert.equal(review.attested, false);
});
