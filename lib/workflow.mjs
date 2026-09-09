import {
  projectDecision,
  repairDecision,
  taskWeights,
} from './project-series.mjs';
import workflow from '../rules/workflow.json' with { type: 'json' };
export { workflow };
export function scoreInstructions() {
  return `评分规则 ${workflow.version}：\n${workflow.scoreLevels.join('；')}\n${workflow.dimensions.map((d) => d.name + '：' + d.rubric).join('\n')}\n${workflow.feedback.join('\n')}\nwhen、behavior、impact、expected、evidenceRefs 必须各有 5 条，按五维顺序；processFindings、artifactFindings 分别说明过程和产物问题（无问题也说明核验依据）。evidenceRefs 每条必须是实际存在的文件路径:行号，引用轨迹或产物，禁止伪造。`;
}
export function nextDecision(task, turn, config) {
  if (!config.autoContinue) return null;
  if (turn.executionOutcome === 'truncated')
    return {
      notice: '本轮截断记录已保留，只有真实 Bug 修复允许在原会话追问',
      finishSession: true,
    };
  if (task.projectSeries) return projectDecision(task, turn, config);
  const d = turn.automation?.next?.value;
  if (!d) return null;
  if (
    !['complete', 'repair', 'continue', 'needs_input'].includes(d.action) ||
    !d.reason?.trim()
  )
    throw Error('后续决策无效');
  if (d.action === 'repair') return repairDecision(task, turn, d);
  return {
    finishSession: true,
    notice:
      d.action === 'continue'
        ? '只允许带具体问题的 Bug 修复追问，不能自动续写'
        : d.reason,
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
  const totals = { ...counts };
  for (const t of tasks)
    for (const r of t.turns) {
      if (r.excluded || !(r.category in counts)) continue;
      const d = new Date(
        new Date(r.finishedAt || r.startedAt || r.createdAt).getTime() +
          8 * 3600000,
      )
        .toISOString()
        .slice(0, 10);
      if (['review', 'submitted'].includes(r.status)) totals[r.category]++;
      if (['review', 'submitted'].includes(r.status) && d === day)
        counts[r.category]++;
      if (['queued', 'running'].includes(r.status)) reserved[r.category]++;
    }
  const suggested = Object.keys(taskWeights).sort(
    (a, b) =>
      (totals[a] + reserved[a] + 1) / taskWeights[a] -
      (totals[b] + reserved[b] + 1) / taskWeights[b],
  )[0];
  return {
    counts,
    totals,
    reserved,
    suggested,
    weights: taskWeights,
    note: '跨项目累计目标 7:7:10:1:1；Bug 仅取真实缺陷，每个会话最多两轮修复，缺少 Bug 时记录比例偏差，不改分类凑数。',
  };
}
