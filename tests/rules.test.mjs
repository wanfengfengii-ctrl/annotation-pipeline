import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deadline,
  validSnapshot,
  issues,
  counted,
  csv,
} from '../lib/pipeline.ts';
test('北京时间 20:00 分界和跨月截止', () => {
  assert.equal(deadline('2026-09-07T11:59:59Z'), '2026-09-07T15:59:59.999Z');
  assert.equal(deadline('2026-09-07T12:00:00Z'), '2026-09-08T06:00:00.000Z');
  assert.equal(deadline('2026-09-30T13:00:00Z'), '2026-10-01T06:00:00.000Z');
});
test('快照只接受完整 GitHub Commit', () => {
  assert.equal(
    validSnapshot('https://github.com/org/repo/commit/' + 'a'.repeat(40)),
    true,
  );
  for (const s of [
    'https://github.com/org/repo/commit/abcdef',
    'https://github.com/org/repo/tree/main',
    'https://evil.com/org/repo/commit/' + 'a'.repeat(40),
  ])
    assert.equal(validSnapshot(s), false);
});
test('逐轮完整性、排除与 CSV 公式安全', () => {
  const r = {
    id: 't1',
    status: 'review',
    createdAt: '2026-09-07T11:00:00Z',
    category: 'Feature 迭代',
    difficulty: '中等',
    prompt: '=DANGEROUS()',
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/trace',
    review: {
      scores: [5, 4, 3, 2, 1],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
      reviewer: '人',
      attested: true,
      other: '',
    },
  };
  const task = {
    title: '任务',
    stack: 'TS',
    harnessVersion: '2.1',
    os: 'macOS',
    snapshot: 'https://github.com/org/repo/commit/' + 'a'.repeat(40),
    turns: [r],
  };
  assert.deepEqual(issues(task, r), []);
  assert.match(csv([task]), /'=DANGEROUS/);
  assert.equal(issues(task, { ...r, promptId: '' }).length, 1);
  assert.equal(
    issues(task, { ...r, review: { ...r.review, attested: false } }).length,
    1,
  );
  assert.equal(counted({ ...task, turns: [r, { ...r, excluded: true }] }), 1);
  assert.ok(
    !csv([{ ...task, turns: [{ ...r, excluded: true }] }]).includes(
      'DANGEROUS',
    ),
  );
});
