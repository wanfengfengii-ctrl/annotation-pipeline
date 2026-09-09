import { continuationDecision } from './round-context.mjs';
export const seriesVersion = '2026-09-08.project1';
export const followupCategories = [
  'Feature 迭代',
  'Bug 修复',
  '代码理解',
  '代码重构',
  '工程化',
  '代码测试',
];
export function claudeCallCount(task) {
  return task.turns.reduce(
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
export function canAddTurn(task) {
  return task.turns.length < 10 && claudeCallCount(task) < 10;
}
export function validateSeries(series) {
  if (
    !series ||
    series.version !== seriesVersion ||
    !/^projects\/p-[a-f0-9-]{36}$/.test(series.directory)
  )
    throw Error('项目连续出题配置无效');
  return series;
}
export function seriesPrompt(task) {
  return task.projectSeries
    ? `项目连续出题规则：同一个项目最多 10 次交互（失败调用也占次数），每道独立题目使用新容器和新 Claude 会话，启动后导入上题已归档代码；只有继续原题才沿用当前会话。项目目录 ${task.projectSeries.directory}，宿主机仓库只作为出题参考，不会挂载到容器；所有产物限制在 /workspace 内的该项目目录。首题必须从零构建独立项目，题型为 0-1 代码生成。截断后继续原题时沿用原题分类和验收目标，0-1 续写仍为 0-1，不等于再建项目。后续基于该目录的真实产物出题，禁止再次从零另建项目、换皮重复或拆小题凑轮次。已发现的真实缺陷优先 Bug 修复；项目基础可用后选择 Feature 迭代，其次代码理解 ≈ 代码重构，再考虑工程化或测试。不要为凑比例凭空假设 Bug。所有题仍须通过禁出、雷同和难度审核。`
    : '';
}
export function nextCategory(task, daily) {
  const counts = Object.fromEntries(followupCategories.map((c) => [c, 0]));
  if (daily)
    for (const c of followupCategories)
      counts[c] = (daily.counts?.[c] || 0) + (daily.reserved?.[c] || 0);
  else
    for (const r of task.turns)
      if (!r.excluded && r.category in counts) counts[r.category]++;
  const weights = [3, 3, 2, 2, 1, 1];
  return [...followupCategories].sort(
    (a, b) =>
      counts[a] / weights[followupCategories.indexOf(a)] -
      counts[b] / weights[followupCategories.indexOf(b)],
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
  if (!canAddTurn(task))
    return { notice: '同一项目已达到 10 次上限，后续请新建项目会话' };
  if (d.action === 'continue') return continuationDecision(turn, d.reason);
  if (['complete', 'needs_input'].includes(d.action))
    return { notice: d.reason };
  if (
    !d.prompt?.trim() ||
    d.prompt.length > 80000 ||
    !followupCategories.includes(d.category) ||
    !['简单', '中等', '困难', '地狱'].includes(d.difficulty) ||
    !d.projectEvidence?.trim()
  )
    throw Error('后续题目缺少真实项目依据或有效分类');
  if (d.action === 'advance' && d.baseComplete !== true)
    throw Error('基础项目尚未可用，只能先修复，不能进入扩展题');
  if (d.action === 'repair' && d.category !== 'Bug 修复')
    throw Error('修复决策必须对应真实缺陷修复');
  if (
    task.turns.some(
      (r) => (r.requestedPrompt || r.prompt).trim() === d.prompt.trim(),
    )
  )
    return { notice: '后续题目与已有题目重复，停止重复出题' };
  return {
    prompt: d.prompt,
    category: d.category,
    difficulty: d.difficulty,
    notice: d.reason,
  };
}
