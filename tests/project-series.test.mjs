import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAddTurn,
  claudeCallCount,
  projectDecision,
  nextCategory,
  validateSeries,
  seriesVersion,
  projectCounts,
  canRepair,
  sessionTurns,
  shouldFinishSession,
} from '../lib/project-series.mjs';
const root = (id, category = '0-1 代码生成') => ({
  id,
  questionRootId: id,
  prompt: '功能 ' + id,
  category,
  status: 'review',
  difficulty: '中等',
  claudeAttempts: ['one'],
});
const choice = {
  action: 'advance',
  prompt: '在项目中增加新的通知能力',
  category: 'Feature 迭代',
  difficulty: '困难',
  reason: '现有功能需要扩展',
  baseComplete: true,
  projectEvidence: 'src/engine.ts 的现有逻辑',
};
function decide(value, task = { turns: [root('a')] }) {
  const turn = {
    ...task.turns.at(-1),
    automation: { next: { value: { ...choice, ...value } } },
  };
  return projectDecision(
    { ...task, turns: task.turns.map((r) => (r.id === turn.id ? turn : r)) },
    turn,
    { autoContinue: true },
  );
}
test('Whole new functions count as 0-1 while iterations reuse the existing project', () => {
  assert.equal(decide({ category: '0-1 代码生成' }).category, '0-1 代码生成');
  assert.equal(decide({}).category, 'Feature 迭代');
  assert.throws(() => decide({ baseComplete: false }), /基础项目/);
  assert.throws(() => decide({ projectEvidence: '' }), /真实项目/);
  assert.throws(() => decide({ category: 'Bug 修复' }), /当前会话/);
  assert.equal(nextCategory({ turns: [root('a')] }), 'Feature 迭代');
  assert.throws(() =>
    validateSeries({ version: seriesVersion, directory: '../escape' }),
  );
});
test('Only Bug repairs reuse a session, at most two and never over ten calls', () => {
  const first = root('a'),
    task = { turns: [first] };
  const d = decide(
    {
      action: 'repair',
      category: 'Bug 修复',
      prompt: '筛选后页码没有重置，把这个问题修好',
    },
    task,
  );
  assert.equal(d.repairOf, 'a');
  assert.equal(d.questionRootId, 'a');
  const second = {
      ...root('b', 'Bug 修复'),
      questionRootId: 'a',
      repairOf: 'a',
    },
    third = { ...root('c', 'Bug 修复'), questionRootId: 'a', repairOf: 'b' };
  task.turns.push(second);
  assert.equal(canRepair(task, second), true);
  task.turns.push(third);
  assert.equal(canRepair(task, third), false);
  assert.equal(sessionTurns(task, third).length, 3);
  assert.equal(
    decide({ action: 'repair', category: 'Bug 修复' }, task).prompt,
    undefined,
  );
  assert.equal(decide({ action: 'continue' }, task).prompt, undefined);
  assert.throws(
    () =>
      decide({
        action: 'repair',
        category: 'Bug 修复',
        prompt: '可能是列表有问题',
      }),
    /口语/,
  );
  assert.equal(
    canRepair(
      { turns: [{ ...first, claudeAttempts: Array(10).fill('failed') }] },
      { ...first, claudeAttempts: Array(10).fill('failed') },
    ),
    false,
  );
});
test('Each project can allocate ten 0-1 and ten Feature roots; failed/excluded slots remain consumed', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({
      ...root('a' + i),
      excluded: true,
    })),
    task = { turns };
  assert.equal(canAddTurn(task, '0-1 代码生成'), false);
  assert.equal(canAddTurn(task, 'Feature 迭代'), true);
  assert.equal(canAddTurn(task), true);
  turns.push(
    ...Array.from({ length: 10 }, (_, i) => root('f' + i, 'Feature 迭代')),
  );
  assert.equal(canAddTurn(task), false);
  assert.equal(projectCounts(task)['Feature 迭代'], 10);
  assert.equal(claudeCallCount(task), 20);
  assert.equal(claudeCallCount(task, 'f9'), 1);
});
test('Weighted fresh questions respect accumulated counts and exclude standalone Bugs', () => {
  const task = { turns: [root('a')] };
  const c = nextCategory(task, {
    totals: {
      '0-1 代码生成': 7,
      'Feature 迭代': 7,
      'Bug 修复': 0,
      代码理解: 0,
      代码重构: 1,
    },
    reserved: {},
  });
  assert.equal(c, '代码理解');
});
test('Completed sessions and mismatched containers cannot accept manual Bug follow-ups', () => {
  const turn = { ...root('a'), sessionFinished: true };
  const task = {
    turns: [turn],
    container: { status: 'running', questionId: 'a' },
  };
  assert.equal(canRepair(task, turn), false);
  turn.sessionFinished = false;
  assert.equal(canRepair(task, turn), true);
  task.container.questionId = 'another';
  assert.equal(canRepair(task, turn), false);
  task.container.questionId = 'a';
  task.closed = true;
  assert.equal(canRepair(task, turn), false);
});
test('An unconfirmed third interaction survives automatic cleanup until resolved or explicitly excluded', () => {
  const first = root('a'),
    second = { ...root('b', 'Bug 修复'), questionRootId: 'a', repairOf: 'a' },
    third = {
      ...root('c', 'Bug 修复'),
      questionRootId: 'a',
      repairOf: 'b',
      status: 'failed',
    },
    task = { turns: [first, second, third] };
  assert.equal(shouldFinishSession(task), false);
  third.claudeAttempts = Array(8).fill('attempt');
  assert.equal(shouldFinishSession(task), false);
  third.status = 'running';
  assert.equal(shouldFinishSession(task), false);
  third.status = 'review';
  assert.equal(shouldFinishSession(task), true);
  third.status = 'failed';
  third.excluded = true;
  assert.equal(shouldFinishSession(task), true);
  third.recoveryBlocked = true;
  assert.equal(shouldFinishSession(task), false);
  assert.equal(shouldFinishSession({ turns: [] }), false);
});
