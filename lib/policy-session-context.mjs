import { questionRoot } from './question-session.mjs';
import {
  sessionTurns,
  claudeCallCount,
  sessionLimits,
} from './project-series.mjs';

// Project history gives product context; only a question root consumes its
// session quota. Keep recorded logical questions separate from sent calls.
export function policySessionContext(task, turn) {
  const currentIndex =
    task.turns?.findIndex((item) => item.id === turn?.id) ?? -1;
  if (currentIndex < 0) throw Error('会话审核上下文缺少当前轮次');
  const current = task.turns[currentIndex];
  const questionRootId = questionRoot(task, current);
  const sameSession = sessionTurns(task, current);
  const isRepair = (item) => !!item.repairOf || item.category === 'Bug 修复';
  const calls = (item) => claudeCallCount({ turns: [item] });
  const knownSessionIds = [
    ...new Set(sameSession.map((item) => item.sessionId).filter(Boolean)),
  ];
  if (task.container?.questionId === questionRootId && task.container.sessionId)
    knownSessionIds.push(task.container.sessionId);
  const sessionIds = [...new Set(knownSessionIds)];
  const sessionId = sessionIds.length === 1 ? sessionIds[0] : null;
  const sessionIdentityConsistent = sessionIds.length <= 1;
  const previous = task.turns.slice(0, currentIndex);
  const priorSameSession = previous.filter(
    (item) => questionRoot(task, item) === questionRootId,
  );
  const otherRootHistory = previous.filter(
    (item) => questionRoot(task, item) !== questionRootId,
  );
  const describe = (item) => ({
    id: item.id,
    questionRootId: questionRoot(task, item),
    // An unsent draft has no native ID of its own. The enclosing context states
    // which existing session it will join, without inventing a sent record.
    sessionId: item.sessionId || null,
    category: item.category,
    status: item.status,
    stage: item.stage,
    repairOf: item.repairOf || null,
    continuationOf: item.continuationOf || null,
    excluded: !!item.excluded,
    recordedClaudeCallCount: calls(item),
    historyScope:
      questionRoot(task, item) === questionRootId
        ? 'same-question-session'
        : 'other-question-session',
  });
  const currentLogicalTurn = priorSameSession.length + 1;
  const currentBugRepairOrdinal = isRepair(current)
    ? priorSameSession.filter(isRepair).length + 1
    : 0;
  const recordedLogicalTurns = sameSession.length;
  const recordedBugRepairs = sameSession.filter(isRepair).length;
  const sentClaudeCalls = claudeCallCount(task, questionRootId);
  const currentSentClaudeCalls = calls(current);
  const currentAlreadySent = currentSentClaudeCalls > 0;
  const violations = [];
  if (!sessionIdentityConsistent)
    violations.push(
      '同一原题记录了不同 Claude sessionId，需核对原生会话，不能新发题目',
    );
  if (recordedLogicalTurns > sessionLimits.maxLogicalTurns)
    violations.push('当前原题会话超过三条逻辑题目上限');
  if (recordedBugRepairs > sessionLimits.maxBugRepairs)
    violations.push('当前原题会话超过两轮 Bug 修复上限');
  if (
    sentClaudeCalls > sessionLimits.maxCalls ||
    (!currentAlreadySent && sentClaudeCalls >= sessionLimits.maxCalls)
  )
    violations.push('当前原题会话已无可用 Claude 调用额度，最多十次');
  const withinSessionLimits = violations.length === 0;
  return {
    questionRootId,
    sessionId,
    recordedSessionIds: sessionIds,
    sessionIdentityConsistent,
    currentTurnId: current.id,
    currentLogicalTurn,
    currentBugRepairOrdinal,
    recordedLogicalTurns,
    recordedBugRepairs,
    sentClaudeCalls,
    priorSentClaudeCalls: priorSameSession.reduce(
      (count, item) => count + calls(item),
      0,
    ),
    currentSentClaudeCalls,
    currentAlreadySent,
    remainingClaudeCalls: Math.max(0, sessionLimits.maxCalls - sentClaudeCalls),
    limits: { ...sessionLimits },
    withinSessionLimits,
    // This describes quota only, and never overrides queue, policy, container,
    // trace or permission gates. A sent/uncertain interaction is never resent.
    maySendUnsentCurrentTurn:
      withinSessionLimits &&
      !currentAlreadySent &&
      !current.excluded &&
      !task.closed,
    violations,
    current: describe(current),
    sameRootPreviousRecords: priorSameSession.map(describe),
    otherRootHistory: otherRootHistory.map(describe),
    countingRule:
      '同一项目的不同 questionRootId 属于独立会话，不把其他原题的 Bug 修复计入当前会话；当前未发送草稿计一条逻辑题目，不计已发送调用。排除或失败记录仍按既有额度规则保留。只有同会话最多三题、两轮 Bug 修复和十次实际调用全部满足才有额度；本上下文不替代其他执行校验，也不授权重发已发送或状态不明的题目。',
  };
}
