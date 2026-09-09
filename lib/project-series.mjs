import workflow from '../rules/workflow.json' with { type: 'json' };
import { questionRoot } from './question-session.mjs';
import { proseIssues, isPlainContinuation } from './writing-style.mjs';
export const seriesVersion = '2026-09-09.project2';
export const taskWeights = workflow.taskMix;
export const freshCategories = [
  '0-1 代码生成',
  'Feature 迭代',
  '代码理解',
  '代码重构',
];
export const followupCategories = [...freshCategories, 'Bug 修复'];
export const sessionLimits = workflow.sessionLimits;
export function claudeCallCount(task, rootId) {
  return task.turns
    .filter((r) => !rootId || questionRoot(task, r) === rootId)
    .reduce(
      (n, r) =>
        n +
        (Array.isArray(r.claudeAttempts)
          ? r.claudeAttempts.length
          : r.promptId ||
              r.sessionId ||
              ['claude', 'score', 'delivery', 'next', 'project-next'].includes(
                r.stage,
              )
            ? 1
            : 0),
      0,
    );
}
export function projectCounts(task) {
  return Object.fromEntries(
    freshCategories.map((c) => [
      c,
      task.turns.filter(
        (r) => !r.repairOf && !r.continuationOf && r.category === c,
      ).length,
    ]),
  );
}
export function canAddTurn(task, category) {
  const counts = projectCounts(task),
    limits = workflow.projectLimits;
  if (Object.entries(limits).every(([c, max]) => counts[c] >= max))
    return false;
  if (!category) return true;
  return (
    freshCategories.includes(category) &&
    (!limits[category] || counts[category] < limits[category])
  );
}
export function sessionTurns(task, turn) {
  const root = questionRoot(task, turn);
  return task.turns.filter((r) => questionRoot(task, r) === root);
}
export function canRepair(task, turn) {
  if (
    !turn ||
    turn.claudeCallCount >= sessionLimits.maxCalls ||
    task.turns.at(-1)?.id !== turn.id ||
    turn.excluded ||
    !['review', 'submitted'].includes(turn.status)
  )
    return false;
  if (task.container && task.container.status !== 'running') return false;
  const turns = sessionTurns(task, turn);
  return (
    turns.length < sessionLimits.maxLogicalTurns &&
    turns.filter((r) => r.repairOf || r.category === 'Bug 修复').length <
      sessionLimits.maxBugRepairs &&
    claudeCallCount(task, questionRoot(task, turn)) < sessionLimits.maxCalls &&
    !turns.some((r) => r.permissionAudit && !r.permissionAudit.passed)
  );
}
export function repairDecision(task, turn, d) {
  if (!canRepair(task, turn))
    return {
      notice: '本会话已结束或达到两轮 Bug 修复/十次调用上限，停止继续修复',
      finishSession: true,
    };
  if (
    !d.prompt?.trim() ||
    isPlainContinuation(d.prompt) ||
    d.prompt.length > 80000 ||
    proseIssues(d.prompt).length
  )
    throw Error('Bug 修复需使用平淡口语描述具体问题，不能只写继续');
  if (
    task.turns.some(
      (r) => (r.requestedPrompt || r.prompt)?.trim() === d.prompt.trim(),
    )
  )
    return {
      notice: '修复目标与已记录问题重复，停止重复追问',
      finishSession: true,
    };
  return {
    prompt: d.prompt,
    category: 'Bug 修复',
    difficulty: d.difficulty || turn.difficulty,
    repairOf: turn.id,
    questionRootId: questionRoot(task, turn),
    notice: d.reason,
  };
}
export function validateSeries(series) {
  if (
    !series ||
    ![seriesVersion, '2026-09-08.project1'].includes(series.version) ||
    !/^projects\/p-[a-f0-9-]{36}$/.test(series.directory)
  )
    throw Error('项目连续出题配置无效');
  return series;
}
export function seriesPrompt(task) {
  return `项目连续出题规则：${workflow.taskDefinitions.join(' ')}${task.projectSeries ? '项目目录 ' + task.projectSeries.directory + '，所有产物限制在 /workspace 中该项目目录。' : ''}修复追问也应像日常交流一样说明已观察到的问题和期望结果，不使用可能、竟然、引号或分项标签，不编造人工操作经历。所有题目仍需通过禁出、雷同和难度审核。`;
}
export function nextCategory(task, mix) {
  const counts = mix
    ? Object.fromEntries(
        freshCategories.map((c) => [
          c,
          ((mix.totals || mix.counts)?.[c] || 0) + (mix.reserved?.[c] || 0),
        ]),
      )
    : projectCounts(task);
  return freshCategories
    .filter((c) => canAddTurn(task, c))
    .sort(
      (a, b) =>
        (counts[a] + 1) / taskWeights[a] - (counts[b] + 1) / taskWeights[b],
    )[0];
}
export function projectDecision(task, turn, config) {
  if (!config.autoContinue) return null;
  const d = turn.automation?.next?.value;
  if (!d) return null;
  if (
    !['advance', 'repair', 'continue', 'complete', 'needs_input'].includes(
      d.action,
    ) ||
    !d.reason?.trim()
  )
    throw Error('项目后续决策无效');
  if (['complete', 'needs_input'].includes(d.action))
    return { notice: d.reason, finishSession: true };
  if (d.action === 'continue')
    return {
      notice: '只有有具体缺陷依据的 Bug 修复允许同会话追问，截断记录已保留',
      finishSession: true,
    };
  if (d.action === 'repair') {
    if (d.category !== 'Bug 修复' || !d.projectEvidence?.trim())
      throw Error('修复决策必须包含真实缺陷及项目依据');
    return repairDecision(task, turn, d);
  }
  if (d.category === 'Bug 修复')
    throw Error('Bug 修复必须关联当前会话，不能新建独立 Bug 会话');
  if (!freshCategories.includes(d.category)) throw Error('独立题型无效');
  if (!canAddTurn(task, d.category))
    return {
      notice: '已达到项目题型上限：0-1 和 Feature 各最多十题',
      finishSession: true,
    };
  if (
    !d.prompt?.trim() ||
    d.prompt.length > 80000 ||
    !freshCategories.includes(d.category) ||
    !['简单', '中等', '困难', '地狱'].includes(d.difficulty) ||
    !d.projectEvidence?.trim()
  )
    throw Error('后续题目缺少真实项目依据或有效分类');
  if (d.baseComplete !== true) throw Error('基础项目尚未可用，不能进入扩展题');
  if (
    task.turns.some(
      (r) => (r.requestedPrompt || r.prompt)?.trim() === d.prompt.trim(),
    )
  )
    return {
      notice: '后续题目与已有题目重复，停止重复出题',
      finishSession: true,
    };
  return {
    prompt: d.prompt,
    category: d.category,
    difficulty: d.difficulty,
    notice: d.reason,
  };
}
