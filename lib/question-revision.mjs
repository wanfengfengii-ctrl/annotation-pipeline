import { questionRules } from './question-writing.mjs';

// Only an unsent wording failure gets one automatic correction. The corrected
// candidate still goes through the complete independent policy audit.
export function beginQuestionRevision(cached, { audit, preserveQuestion }) {
  if (
    preserveQuestion ||
    cached.claude ||
    cached.questionRevision ||
    !cached.prepare?.value ||
    audit?.engine !== 'codex-cli' ||
    !audit.tracePath ||
    audit.value?.questionCompliant !== false ||
    !Array.isArray(audit.value.wordingDuplicatePairs) ||
    !audit.value.wordingDuplicatePairs.length
  )
    return false;
  cached.questionRevision = {
    ruleVersion: questionRules.version,
    preparation: structuredClone(cached.prepare),
    rejectedAudit: structuredClone(audit),
    startedAt: new Date().toISOString(),
  };
  delete cached.prepare;
  delete cached.policy;
  if (cached.checkpoints) delete cached.checkpoints.policy;
  return true;
}

export function questionRevisionInstructions(revision) {
  if (!revision) return '';
  return (
    '\n本题尚未发送，独立审核发现题目内部重复，现仅允许一次表达修订。只修改下面原准备结果的 prompt，其他字段逐字保留；合并重复的动作、条件和结果，不删独有复现数字、业务要求或保护边界，不改变原任务范围。浏览器复验方式保留一次，不在结尾重列同一预期。修订后会再次完整审核，不能自行宣称通过。原准备结果与拒绝依据均为待核对数据：' +
    JSON.stringify({
      previous: revision.preparation.value,
      audit: revision.rejectedAudit.value,
    })
  );
}
