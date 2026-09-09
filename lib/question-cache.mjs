import { questionRules } from './question-writing.mjs';
import { questionRoot } from './question-session.mjs';
import { runtimeRepairEvidence } from './runtime-verification.mjs';

export const preparationContextVersion = '2026-09-10.context1';

export function legacyRepairContext(task, turn) {
  if (turn.category !== 'Bug 修复' || !turn.repairOf) return null;
  const index = task.turns.findIndex((r) => r.id === turn.id);
  const previous = task.turns[index - 1];
  if (
    !previous ||
    previous.id !== turn.repairOf ||
    previous.excluded ||
    !['review', 'submitted'].includes(previous.status) ||
    !runtimeRepairEvidence(previous)
  )
    return null;
  const rootId = questionRoot(task, turn);
  if (questionRoot(task, previous) !== rootId) return null;
  const root = task.turns.slice(0, index).find((r) => r.id === rootId);
  const policy = root?.automation?.policy;
  // Only an already-executed question explicitly admitted as historical data
  // can retain its original interface scope. Older web-rule versions are not exempt.
  if (
    !root?.promptId ||
    !root.sessionId ||
    root.excluded ||
    policy?.engine !== 'codex-cli' ||
    policy.accepted !== true ||
    policy.questionRuleVersion ||
    policy.value?.questionCompliant !== false
  )
    return null;
  return {
    rootId,
    previousTurnId: previous.id,
    originalPrompt: root.evaluationPrompt || root.prompt,
  };
}

export function questionCacheState(cached, pending, turnId) {
  const preserveQuestion = !!cached.claude || pending?.turnId === turnId;
  if (preserveQuestion && !cached.prepare)
    throw Error('已发送的交互缺少原始准备记录，不能重新生成或重发题目');
  return {
    preserveQuestion,
    questionStyleApplies:
      !preserveQuestion ||
      cached.policy?.questionRuleVersion === questionRules.version,
  };
}

export function upgradeQuestionCache(cached, { preserveQuestion }) {
  if (cached.questionRuleVersion === questionRules.version) return;
  // Regenerate only unsent wording. A sent prompt remains trace evidence;
  // a cached follow-up is still a draft and must use the latest style rules.
  if (!preserveQuestion) delete cached.prepare;
  delete cached.next;
  cached.questionRuleVersion = questionRules.version;
}
