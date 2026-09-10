import {
  projectDecision,
  repairDecision,
  taskWeights,
  canRepair,
} from './project-series.mjs';
import { runtimeRepairEvidence } from './runtime-verification.mjs';
import workflow from '../rules/workflow.json' with { type: 'json' };
import { businessTurnId } from './gateway-continuation.mjs';
import { scoreConsistencyInstructions } from './score-consistency.mjs';
export { workflow };
const scoreExplanationInstructions = [
  '五个维度分别按本维定义和分档条款独立判断，不能用总分档名称代替本维标准。descriptions 每项在自然的一段话中说明实际证据为什么符合所选档位，以及为什么不足以进入相邻高档、又未达到相邻低档的严重程度；1 分或 5 分只比较存在的相邻档。不需要罗列所有档位，也不能为沿用旧分数而凑理由，分数由本次 AI 核验后自行决定。',
  'processFindings 标明本次采用的评分规则版本；选档理由写入各维 descriptions，继续保留 when、behavior、impact、expected、evidenceRefs，不新增 schema 未定义的分档字段，不使用小标题或模板标签堆砌点评。',
  'artifactFindings 按本轮最新且已验真的独立运行验收报告及原日志说明当前状态，涉及测试时核对并写明实际运行数、通过数、失败数和跳过数，以及依赖准备方式和证据范围。不能把历史 blocked、旧安装失败或执行前尚未运行的文字当成本轮最终状态；新验收已实际运行的测试必须如实记录，评分阶段仅只读、未重新运行测试不等于独立验收没有运行。',
  '独立验收检查的 expected 是执行前预期和测试计划，原文中的本阶段尚未运行属于当时状态；执行后的结论按已验真的 outcome、observed、退出码及原日志判断。在 artifactFindings 明确区分执行前预期与当前已执行结果，不能把 expected 覆盖真实结果，也不能改写原计划、报告、日志或历史评分及拒审记录。缺少真实执行证据仍写未验证，不能仅凭 outcome 名称或模型自报断言通过。',
  '临时副本按原 manifest 安装依赖后测试通过，只证明该条件下的实际测试结果；保留原 npm ci 失败和清单与锁文件错配的交付问题，不能声称干净安装通过。独立验收的操作不得归为被测模型的行为，环境限制与模型问题分列。',
  '交付完整性的 4 分和 5 分都要求无虚假成功；若原始轨迹证实模型把未完成的验证描述为已完成，不能因为独立验收后来通过而消除该表述问题。按原分档判断虚假成功的实际范围和严重程度，轻微情况对应 3 分条款，严重情况按更低档评估；仅缺少工具记录不自动等同虚假成功，先核对模型原话、实际工具和验证范围，不把环境故障当作模型失实。',
];
export function scoreInstructions() {
  return `评分规则 ${workflow.version}：\n${workflow.scoreLevels.join('；')}\n${workflow.dimensions.map((d) => d.name + '：' + d.rubric).join('\n')}\n${workflow.feedback.join('\n')}\n${scoreExplanationInstructions.join('\n')}\n${scoreConsistencyInstructions()}\nwhen、behavior、impact、expected、evidenceRefs 必须各有 5 条，按五维顺序；processFindings、artifactFindings 分别说明过程和产物问题（无问题也说明核验依据）。evidenceRefs 每维提供 1 至 8 个实际存在的文件路径:行号，多个引用用分号分隔，不附加解释，每个引用均独立核验和归档；引用轨迹或产物，禁止伪造。`;
}
export function nextDecision(task, turn, config) {
  if (!config.autoContinue) return null;
  if (
    runtimeRepairEvidence(turn) &&
    canRepair(task, turn) &&
    turn.automation?.next?.value?.action !== 'repair'
  )
    throw Error('已复现原题缺陷且仍有修复额度，必须先生成 Bug 修复题');
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
    for (const r of new Map(
      t.turns.map((r) => [businessTurnId(t, r) ?? r, r]),
    ).values()) {
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
