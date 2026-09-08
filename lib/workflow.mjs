import { continuationDecision } from './round-context.mjs';
import { projectDecision, canAddTurn } from './project-series.mjs';
import workflow from '../rules/workflow.json' with { type: 'json' };
export { workflow };
export function scoreInstructions() {
  return `评分规则 ${workflow.version}：\n${workflow.scoreLevels.join('；')}\n${workflow.dimensions.map((d) => d.name + '：' + d.rubric).join('\n')}\n${workflow.feedback.join('\n')}\nwhen、behavior、impact、expected、evidenceRefs 必须各有 5 条，按五维顺序；processFindings、artifactFindings 分别说明过程和产物问题（无问题也说明核验依据）。evidenceRefs 每条必须是实际存在的文件路径:行号，引用轨迹或产物，禁止伪造。`;
}
export function nextDecision(task, turn, config) {
  if (config.autoContinue && turn.executionOutcome === 'truncated') {
    if (!canAddTurn(task))
      return { notice: '截断轮次已保留；达到 10 次上限，停止继续调用' };
    return continuationDecision(
      turn,
      '截断后继续原题；保留本轮独立评分，下一轮沿用原始验收目标',
    );
  }
  if (task.projectSeries) return projectDecision(task, turn, config);
  const decision = turn.automation?.next?.value;
  if (!config.autoContinue || !decision) return null;
  if (
    !['complete', 'repair', 'continue', 'needs_input'].includes(
      decision.action,
    ) ||
    typeof decision.reason !== 'string' ||
    !decision.reason.trim()
  )
    throw Error('后续决策无效');
  if (decision.action === 'complete' || decision.action === 'needs_input')
    return { notice: decision.reason };
  if (!canAddTurn(task))
    return { notice: '已达 10 轮上限，保留各轮数据并结束自动交互' };
  if (
    typeof decision.prompt !== 'string' ||
    !decision.prompt.trim() ||
    decision.prompt.length > 80000
  )
    throw Error('后续 Prompt 无效');
  if (
    task.turns.filter(
      (r) =>
        r.prompt === decision.prompt || r.requestedPrompt === decision.prompt,
    ).length >= 2
  )
    return { notice: '同一后续目标已重复两次，暂停自动续跑以检查无进展问题' };
  if (decision.action === 'continue')
    return continuationDecision(turn, decision.reason);
  return {
    prompt: decision.prompt,
    category: 'Bug 修复',
    notice: decision.reason,
  };
}
export function dailyMix(tasks, day) {
  const categoryNames = [
    '0-1 代码生成',
    'Feature 迭代',
    'Bug 修复',
    '代码理解',
    '代码重构',
    '工程化',
    '代码测试',
  ];
  const counts = Object.fromEntries(categoryNames.map((c) => [c, 0]));
  const reserved = { ...counts };
  for (const t of tasks)
    for (const r of t.turns) {
      if (r.excluded || !(r.category in counts)) continue;
      const d = new Date(
        new Date(r.finishedAt || r.startedAt || r.createdAt).getTime() +
          8 * 3600000,
      )
        .toISOString()
        .slice(0, 10);
      if (['review', 'submitted'].includes(r.status) && d === day)
        counts[r.category]++;
      if (['queued', 'running'].includes(r.status)) reserved[r.category]++;
    }
  // Operational weights express the documented priority, not a claimed numeric requirement.
  const weights = [3, 3, 3, 2, 2, 1, 1];
  const suggested = [...categoryNames].sort(
    (a, b) =>
      (counts[a] + reserved[a]) / weights[categoryNames.indexOf(a)] -
      (counts[b] + reserved[b]) / weights[categoryNames.indexOf(b)],
  )[0];
  return {
    counts,
    reserved,
    suggested,
    note: '3:3:3:2:2:1:1 是调度权重，文档只规定偏序，不是要求比例；按真实任务归类，不改标签凑数。',
  };
}
