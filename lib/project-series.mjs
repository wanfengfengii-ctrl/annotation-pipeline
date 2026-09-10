import workflow from '../rules/workflow.json' with { type: 'json' };
import { questionRoot } from './question-session.mjs';
import {
  disputeContinuationReady,
  blocksProject,
} from './disputed-continuation.mjs';
import { runtimeRepairEvidence } from './runtime-verification.mjs';
import {
  proseIssues,
  questionIssues,
  isPlainContinuation,
} from './writing-style.mjs';
import { questionInstructions, questionRules } from './question-writing.mjs';
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
export function repairBatchInstructions() {
  return `Bug 修复分批出题：一题只选同一业务流程内 ${questionRules.minBusinessDetails} 至 ${questionRules.maxBusinessDetails} 组有真实复现证据的问题细节，围绕这批问题说明 ${questionRules.minFeatures} 至 ${questionRules.maxFeatures} 项受影响的已有操作。操作数量不是缺陷数量，不要为了凑操作数增加独立问题。多于 ${questionRules.maxBusinessDetails} 组缺陷时，先按对当前流程的影响和关联程度选一批，不把全部复现问题塞进一题，也不能把四组独立条件和预期改名合并成两组。repairCheckIds 只填本题实际覆盖的复现检查 ID，未选检查和完整日志仍留在原验收报告中，可在 reason 或 projectEvidence 说明后续范围，不写入当前题面或 acceptance。prepare 仅展开本题已选范围，不从前序报告补回未选缺陷。题面与验收必须逐项沿用真实复现记录里的控件、操作和先后顺序，不能把点击时间点按钮改写成拖动进度条，或把点击、输入、拖放互换；证据只覆盖哪种操作，就只描述哪种操作，缺少依据的交互不能补写成已发生的事实。后续 project-next 和 next 必须逐项核对前序已复现但本题未覆盖的问题，在 reason 或 projectEvidence 保留未解决清单和原报告、检查 ID；本轮局部修复 passed 不能证明这些问题已解决，不能据此写 complete 或 baseComplete=true。缺少剩余问题的新回归证据时明确标记未复核，先补独立复验，不丢弃旧证据或猜测已修好。完成本批后重新验收，只有新报告仍复现的问题才能进入下一批；同会话累计最多 ${sessionLimits.maxBugRepairs} 轮 Bug 修复，已用满仍有问题时 needs_input，不新增第三轮、不换会话绕过限制，也不把尚未修复的缺陷标为完成。每批都重新通过原有禁出、难度及题面审核，不能放宽 ${questionRules.minBusinessDetails} 至 ${questionRules.maxBusinessDetails} 项业务细节规则。`;
}
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
    task.closed ||
    turn.sessionFinished ||
    turn.claudeCallCount >= sessionLimits.maxCalls ||
    task.turns.at(-1)?.id !== turn.id ||
    turn.excluded ||
    (!['review', 'submitted'].includes(turn.status) &&
      !disputeContinuationReady(turn))
  )
    return false;
  if (task.container && task.container.status !== 'running') return false;
  if (
    task.container?.questionId &&
    task.container.questionId !== questionRoot(task, turn)
  )
    return false;
  const turns = sessionTurns(task, turn);
  return (
    turns.length < sessionLimits.maxLogicalTurns &&
    turns.filter((r) => r.repairOf || r.category === 'Bug 修复').length <
      sessionLimits.maxBugRepairs &&
    claudeCallCount(task, questionRoot(task, turn)) < sessionLimits.maxCalls &&
    !turns.some((r) => r.permissionAudit && !r.permissionAudit.passed)
  );
}
export function shouldFinishSession(task) {
  const turn = task.turns.at(-1);
  if (
    !turn ||
    task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    )
  )
    return false;
  // A failed/unconfirmed third prompt must remain recoverable. Limits prevent
  // further prompts; they do not authorize terminating the pending interaction.
  if (blocksProject(turn)) return false;
  return !!(
    task.closed ||
    turn.excluded ||
    turn.sessionFinished ||
    claudeCallCount(task, questionRoot(task, turn)) >= sessionLimits.maxCalls ||
    sessionTurns(task, turn).length >= sessionLimits.maxLogicalTurns ||
    ['complete', 'needs_input'].includes(turn.automation?.next?.value?.action)
  );
}
export function repairDecision(task, turn, d) {
  if (turn.automation?.runtimeVersion && !runtimeRepairEvidence(turn))
    throw Error('Bug 修复题缺少独立运行复现证据');
  if (turn.automation?.runtimeVersion) {
    const confirmed = new Set(
      turn.automation.runtimeVerification.checks
        .filter((c) => c.outcome === 'reproduced')
        .map((c) => c.id),
    );
    if (
      !Array.isArray(d.repairCheckIds) ||
      !d.repairCheckIds.length ||
      d.repairCheckIds.some((id) => !confirmed.has(id))
    )
      throw Error('Bug 修复题必须关联本轮已复现的检查 ID');
  }
  if (!canRepair(task, turn))
    return {
      notice: '本会话已结束或达到两轮 Bug 修复/十次调用上限，停止继续修复',
      finishSession: true,
    };
  if (
    !d.prompt?.trim() ||
    isPlainContinuation(d.prompt) ||
    d.prompt.length > 80000 ||
    (turn.automation?.questionRuleVersion === questionRules.version
      ? questionIssues(d.prompt, { category: 'Bug 修复' })
      : proseIssues(d.prompt, { paragraphs: true })
    ).length
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
  return `项目连续出题规则：${workflow.taskDefinitions.join(' ')}${task.projectSeries ? '项目目录 ' + task.projectSeries.directory + '，所有产物限制在 /workspace 中该项目目录。该路径仅用于定位真实代码，不附加到题目正文；题目自然说明沿用现有项目。' : ''}修复追问说明已观察到的问题和期望结果，不编造人工操作经历。所有题目仍需通过禁出、雷同和难度审核。\n${questionInstructions()}\n${repairBatchInstructions()}`;
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
    turn.automation?.questionRuleVersion === questionRules.version &&
    questionIssues(d.prompt, { category: d.category }).length
  )
    throw Error('后续题目不符合标题、正文长度或表达要求');
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
