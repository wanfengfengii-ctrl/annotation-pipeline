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
  repairDecision,
} from '../lib/project-series.mjs';
import { runtimeVersion } from '../lib/runtime-verification.mjs';
import {
  assertQuestionAudit,
  questionRules,
} from '../lib/question-writing.mjs';
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
test('Four verified defects can be split into two audited repair batches while preserving the original evidence and two-round cap', () => {
  const ids = ['timeline', 'scene', 'moves', 'clock'];
  const report = {
    version: runtimeVersion,
    executed: true,
    status: 'bugs',
    reportPath: '/fixture/runtime/report.json',
    reportSha256: 'a'.repeat(64),
    checks: ids.map((id) => ({
      id,
      kind: 'reproduction',
      outcome: 'reproduced',
      exitCode: 1,
      logPath: '/fixture/runtime/' + id + '.log',
      logSha256: 'b'.repeat(64),
      requirement: '保留原有换景流程',
      codeEvidence: 'app.js:1',
    })),
  };
  const original = JSON.stringify(report);
  const first = {
    ...root('a'),
    automation: {
      runtimeVersion,
      questionRuleVersion: questionRules.version,
      runtimeVerification: report,
    },
  };
  const task = { turns: [first] };
  const prompt =
    '网页时间轴拖动后，动作开始时间仍停在12秒，拉伸后的时长也还是24秒，把这两处改好，让拖动结果显示为17秒、拉伸结果显示为28秒，动作详情和时间轴上的数字要一起更新。先选中要调整的动作，再拖动位置、拉伸长度，回到详情查看，整个过程继续沿用现有页面和操作方式。预演前进到12秒或选到25秒时，舞台已经变化，时间文字和滑块却仍显示0，把它们与舞台时间、当前事件高亮同步。改完再前进、回退和重新选择时间，检查这些控件始终指向同一个时刻，不要改动已经保存的动作安排。';
  const audit = {
    questionCompliant: true,
    wordingRequirements: [
      '原文：动作开始时间仍停在12秒，拉伸后的时长也还是24秒。新增信息：时间轴两种操作的错误结果。',
      '原文：让拖动结果显示为17秒、拉伸结果显示为28秒。新增信息：两种操作的目标数值。',
      '原文：先选中要调整的动作，再拖动位置、拉伸长度，回到详情查看。新增信息：复现和核对操作顺序。',
      '原文：预演前进到12秒或选到25秒时，舞台已经变化，时间文字和滑块却仍显示0。新增信息：预演的两个触发条件及错误状态。',
      '原文：不要改动已经保存的动作安排。新增信息：既有数据保护边界。',
    ],
    wordingDuplicatePairs: [],
    questionChecks: Object.keys(questionRules.criteria).map(
      (id) => id + '：正文有相应已有操作和要求',
    ),
    workflowFeatures: [
      '选中动作',
      '拖动位置',
      '拉伸长度',
      '查看动作详情',
      '前进与回退预演',
      '选择预演时刻',
    ],
    businessDetails: [
      '时间轴拖拉结果与详情同步',
      '时间文字和滑块与舞台时间同步',
    ],
  };
  assert.doesNotThrow(() => assertQuestionAudit(audit));
  assert.doesNotThrow(() =>
    assertQuestionAudit({
      ...audit,
      businessDetails: [
        ...audit.businessDetails,
        '场景出入口隔离',
        '连续搬运位置正确',
      ],
    }),
  );
  const batchOne = repairDecision(task, first, {
    prompt,
    reason: '先修同一时间操作流程',
    repairCheckIds: ['timeline', 'clock'],
  });
  assert.equal(batchOne.repairOf, first.id);
  assert.equal(batchOne.questionRootId, first.id);
  const second = {
    ...root('b', 'Bug 修复'),
    ...batchOne,
    automation: {
      ...first.automation,
      runtimeVerification: {
        ...report,
        checks: report.checks.map((c) =>
          ['timeline', 'clock'].includes(c.id)
            ? { ...c, outcome: 'passed', exitCode: 0 }
            : { ...c },
        ),
      },
    },
  };
  task.turns.push(second);
  const nextPrompt =
    '第一幕的出入口移到(139,317)后，第二幕也跟着移动了，把场景之间的布局分开保存。先切到第一幕调整出入口，再切到第二幕查看，第二幕应继续保留(60,300)，返回第一幕还能看到刚才的位置。接着在原来的动作编辑页给同一沙发安排两次不重叠的搬运，逐步前进和回退检查舞台位置。现在到10秒时，沙发被后一次动作的起点覆盖，状态也变成等待，请按当前时刻显示正在发生的搬运，间歇停在前一次终点。交换两条动作的存放顺序后再看相同时刻，位置与状态应保持一致，别改动其他物件的安排。';
  assert.throws(
    () =>
      repairDecision(task, second, {
        prompt: nextPrompt,
        repairCheckIds: ['timeline'],
      }),
    /已复现/,
  );
  const batchTwo = repairDecision(task, second, {
    prompt: nextPrompt,
    reason: '新验收仍复现另外两项',
    repairCheckIds: ['scene', 'moves'],
  });
  assert.equal(batchTwo.repairOf, second.id);
  task.turns.push({
    ...root('c', 'Bug 修复'),
    ...batchTwo,
    automation: second.automation,
  });
  assert.equal(canRepair(task, task.turns.at(-1)), false);
  assert.equal(
    repairDecision(task, task.turns.at(-1), {
      prompt: nextPrompt,
      repairCheckIds: ['scene'],
    }).finishSession,
    true,
  );
  assert.equal(JSON.stringify(report), original);
});
