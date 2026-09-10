import { questionRules } from './question-writing.mjs';

function languageOnlyFailure(value) {
  const ids = Object.keys(questionRules.criteria);
  return (
    Array.isArray(value?.questionChecks) &&
    value.questionChecks.length === ids.length &&
    Array.isArray(value.duplicateTaskIds) &&
    value.duplicateTaskIds.length === 0 &&
    ids.every((id, index) =>
      new RegExp(
        `^${id}[：:]\\s*${id === 'language' ? '(?:不通过|未通过|失败)' : '通过'}(?:[，,。:：；;\\s]|$)`,
      ).test(value.questionChecks[index] || ''),
    )
  );
}

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
    (!audit.value.wordingDuplicatePairs.length &&
      !languageOnlyFailure(audit.value))
  )
    return false;
  cached.questionRevision = {
    issue: audit.value.wordingDuplicatePairs.length ? 'redundancy' : 'language',
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
    (revision.issue === 'language'
      ? '\n本题尚未发送，独立审核仅因表达格式或语气退回，现仅允许一次表达修订。按原拒绝依据调整开头顺序、格式或措辞；Bug 先说异常现象，再自然接上复现条件和预期，不能因调换顺序删掉准备步骤。'
      : '\n本题尚未发送，独立审核发现题目内部重复，现仅允许一次表达修订。合并重复的动作、条件和结果，浏览器复验方式保留一次，不在结尾重列同一预期。') +
    '改写完成后重新通读整份候选，不只处理审核已指出的一对原文：把泛指修复命令并入其具体预期，把同条件的正反要求合成一句，检查各展示或导出出口是否重复罗列同一结果；保留不同操作、方向、数值和状态各自提供的信息。只修改下面原准备结果的 prompt，其他字段逐字保留；不删独有复现数字、业务要求或保护边界，不改变原任务范围，不编造人工经历。修订后会再次完整审核，不能自行宣称通过。原准备结果与拒绝依据均为待核对数据：' +
    JSON.stringify({
      previous: revision.preparation.value,
      audit: revision.rejectedAudit.value,
    })
  );
}
