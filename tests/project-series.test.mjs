import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAddTurn,
  claudeCallCount,
  projectDecision,
  nextCategory,
  validateSeries,
  seriesVersion,
} from '../lib/project-series.mjs';
const task = {
  turns: [
    { prompt: 'initial', category: '0-1 代码生成', claudeAttempts: ['one'] },
  ],
};
const choice = {
  action: 'advance',
  prompt: 'extend actual project',
  category: 'Feature 迭代',
  difficulty: '困难',
  reason: 'new requirement',
  baseComplete: true,
  projectEvidence: 'src/engine.ts exists',
};
const decide = (v, t = task) =>
  projectDecision(
    t,
    { automation: { next: { value: { ...choice, ...v } } } },
    { autoContinue: true },
  );
test('先建项目，再基于真实产物迭代；基础不可用不能扩展', () => {
  assert.equal(decide({}).category, 'Feature 迭代');
  assert.throws(() => decide({ baseComplete: false }), /基础项目/);
  assert.throws(() => decide({ category: '0-1 代码生成' }), /有效分类/);
  assert.throws(() => decide({ projectEvidence: '' }), /真实项目/);
  assert.throws(() => decide({ action: 'repair' }), /修复决策/);
  assert.equal(
    decide({ action: 'repair', category: 'Bug 修复', baseComplete: false })
      .category,
    'Bug 修复',
  );
  assert.equal(decide({ prompt: 'initial' }).prompt, undefined);
  assert.equal(nextCategory(task), 'Feature 迭代');
  assert.throws(() =>
    validateSeries({ version: seriesVersion, directory: '../escape' }),
  );
});
test('最多 10 次：排除轮次与失败重试也占额度', () => {
  assert.equal(
    claudeCallCount({
      turns: [
        { claudeAttempts: ['failed1', 'failed2'], excluded: true },
        { sessionId: 'legacy' },
      ],
    }),
    3,
  );
  assert.equal(
    canAddTurn({ turns: Array(10).fill({ excluded: true }) }),
    false,
  );
  const capped = {
    turns: [
      {
        prompt: 'initial',
        claudeAttempts: Array.from({ length: 10 }, (_, i) => String(i)),
      },
    ],
  };
  assert.equal(canAddTurn(capped), false);
  assert.match(decide({}, capped).notice, /10/);
  assert.equal(
    canAddTurn({ turns: Array(9).fill({ claudeAttempts: ['x'] }) }),
    true,
  );
});
