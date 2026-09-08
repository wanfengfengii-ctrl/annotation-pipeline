import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continuationContext,
  matchesNativePrompt,
} from '../lib/round-context.mjs';
import { nextDecision } from '../lib/workflow.mjs';
import { nextCategory } from '../lib/project-series.mjs';

test('截断续写是新轮次，原题分类与验收目标跨多次继续保留', () => {
  const first = {
    id: 'a',
    prompt: '从零实现消息重放引擎',
    category: '0-1 代码生成',
    difficulty: '困难',
    status: 'review',
    executionOutcome: 'truncated',
  };
  const task = { projectSeries: {}, turns: [first] };
  const next = nextDecision(task, first, { autoContinue: true });
  assert.equal(next.prompt, '继续');
  assert.equal(next.continuationOf, 'a');
  assert.equal(next.category, '0-1 代码生成');
  const second = {
    id: 'b',
    ...next,
    status: 'review',
    executionOutcome: 'truncated',
  };
  task.turns.push(second);
  assert.equal(
    continuationContext(task, second).evaluationPrompt,
    first.prompt,
  );
  const third = {
    id: 'c',
    ...nextDecision(task, second, { autoContinue: true }),
  };
  task.turns.push(third);
  assert.equal(third.evaluationPrompt, first.prompt);
  assert.equal(continuationContext(task, third).previous.id, 'b');
  assert.throws(
    () =>
      continuationContext(
        { turns: [{ id: 'x', prompt: '继续' }] },
        { id: 'x', prompt: '继续' },
      ),
    /紧邻/,
  );
  assert.equal(nextDecision(task, third, { autoContinue: false }), null);
});

test('后续题型结合当天全局已完成和在途数量，不单看当前项目', () => {
  const t = { turns: [{ category: '0-1 代码生成' }] };
  assert.equal(
    nextCategory(t, {
      counts: { 'Feature 迭代': 20, 'Bug 修复': 20, 代码理解: 0, 代码重构: 1 },
      reserved: {},
    }),
    '代码理解',
  );
  assert.equal(
    nextCategory(t, {
      counts: { 'Feature 迭代': 20, 'Bug 修复': 20, 代码理解: 0, 代码重构: 0 },
      reserved: { 代码理解: 3 },
    }),
    '代码重构',
  );
});

test('相同继续文本不能把上一轮 PromptID 当成本轮 ID', () => {
  const event = { type: 'user', uuid: 'old', message: { content: '继续' } };
  assert.equal(matchesNativePrompt(event, '继续', 'current', ['old']), false);
  assert.equal(matchesNativePrompt(event, '继续', undefined, ['old']), false);
  assert.equal(
    matchesNativePrompt({ ...event, uuid: 'current' }, '继续', 'current', [
      'old',
    ]),
    true,
  );
});
