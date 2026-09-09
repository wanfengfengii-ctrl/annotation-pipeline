import { questionRules } from './question-writing.mjs';

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
