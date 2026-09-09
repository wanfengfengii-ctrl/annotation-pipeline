import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continuationContext,
  matchesNativePrompt,
} from '../lib/round-context.mjs';
import { nextDecision } from '../lib/workflow.mjs';
import { nextCategory } from '../lib/project-series.mjs';

test('New policy retains truncated evidence without automatic non-Bug continuation', () => {
  const first = {
    id: 'a',
    questionRootId: 'a',
    prompt: '全新消息功能',
    category: '0-1 代码生成',
    status: 'review',
    executionOutcome: 'truncated',
  };
  assert.equal(
    nextDecision({ projectSeries: {}, turns: [first] }, first, {
      autoContinue: true,
    }).prompt,
    undefined,
  );
  assert.equal(
    nextDecision({ turns: [first] }, first, {
      autoContinue: true,
    }).finishSession,
    true,
  );
  const legacy = { id: 'b', prompt: '继续', continuationOf: 'a' };
  assert.equal(
    continuationContext({ turns: [first, legacy] }, legacy).evaluationPrompt,
    first.prompt,
  );
});
test('后续题型结合当天全局已完成和在途数量，不单看当前项目', () => {
  const t = { turns: [{ category: '0-1 代码生成' }] };
  assert.equal(
    nextCategory(t, {
      counts: {
        '0-1 代码生成': 20,
        'Feature 迭代': 20,
        'Bug 修复': 20,
        代码理解: 0,
        代码重构: 1,
      },
      reserved: {},
    }),
    '代码理解',
  );
  assert.equal(
    nextCategory(t, {
      counts: {
        '0-1 代码生成': 20,
        'Feature 迭代': 20,
        'Bug 修复': 20,
        代码理解: 0,
        代码重构: 0,
      },
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
