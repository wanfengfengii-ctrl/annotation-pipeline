import rules from '../rules/question-writing.json' with { type: 'json' };
export { rules as questionRules };

export function questionInstructions({ legacyRepair = false } = {}) {
  return (
    `题目内容与格式规则（${rules.version}，优先于旧题示例及出题范围中的冲突要求）：\n${rules.instructions.join('\n')}` +
    (legacyRepair
      ? '\n本轮范围继承说明：执行器已核验，本轮是网页规则启用前已实际执行的历史题目在原会话中的真实 Bug 修复。沿用原题面向的用户、既有业务操作和界面形态；web 和 layout 按原题范围核验，原题无网页时写明不适用，不能强行新增网页、虚构浏览器操作或改变原题验收范围。其余格式、语气、4–6 项受影响操作、1–2 项细节、禁出、雷同、难度及真实复现审核全部保留。此范围继承仅适用于本次关联修复，不适用于首题、0-1、Feature、理解或重构独立新题。'
      : '')
  );
}

export function questionParts(text) {
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  const title = lines.shift() || '';
  const paragraphs = lines.map((s) => s.trim()).filter(Boolean);
  const body = paragraphs.join('\n');
  return {
    title,
    paragraphs,
    body,
    bodyLength: [...body.replace(/\s/g, '')].length,
  };
}

export function questionFormatIssues(text) {
  const { title, paragraphs, body, bodyLength } = questionParts(text);
  const issues = [];
  if (
    !title ||
    /^(?:\d+[、.．)）]|第[\d一二三四五六七八九十百]+题|[#*])/.test(title)
  )
    issues.push('首行只写项目名称，不加题目编号或标题标记');
  if (paragraphs.length < 1 || paragraphs.length > 2)
    issues.push('标题下面写 1 至 2 个自然段，不分行列清单');
  if (bodyLength < rules.minBodyLength || bodyLength > rules.maxBodyLength)
    issues.push(
      `正文需 ${rules.minBodyLength}–${rules.maxBodyLength} 字（含标点、不含标题和空白），当前 ${bodyLength} 字`,
    );
  if (
    /(?:^|\n)\s*(?:[-*#]|\d+[、.．])\s*|(?:技术栈|核心功能|约束要求|选题分析|开场说明|结尾总结)\s*[:：]|```/.test(
      body,
    )
  )
    issues.push('只写自然需求正文，不使用小标题、清单、分析或代码块');
  if (
    /\/workspace\b|projects\/p-[a-f0-9-]+|Claude CLI|Codex CLI|dangerously-skip-permissions|自动评测任务|题型比例|7:7:10:1:1/.test(
      body,
    )
  )
    issues.push('项目路径、权限和评测等编排信息保存在元数据中，不放入题目');
  return issues;
}

export function questionAuditInstructions(options = {}) {
  const criteria = options.legacyRepair
    ? {
        ...rules.criteria,
        web: '依据已执行原题的界面形态核验，原题无网页则注明历史修复不适用，不新增或虚构网页交互',
        layout:
          '沿用原题真实界面与已有操作结构，原题无页面则注明历史修复不适用',
      }
    : rules.criteria;
  return `${questionInstructions(options)}\n独立审核候选实际 prompt 的内容与格式，不能只相信作者自述。questionCompliant 仅在全部适用标准通过时为 true；questionChecks 按下列 ID 顺序逐项返回 ID：正文依据或失败原因，缺失明确写缺少。workflowFeatures 列出正文中 4 至 6 项相互关联的功能或已有业务操作，businessDetails 列出 1 至 2 个正文中的具体业务细节；数量不足或超出时如实返回，禁止编造凑数。reason 说明不合格项，questionCompliant=false 时 allowed 必须为 false。\n${Object.entries(
    criteria,
  )
    .map(([id, description]) => `${id}：${description}`)
    .join('\n')}`;
}

export function assertQuestionAudit(value) {
  const ids = Object.keys(rules.criteria);
  if (
    value?.questionCompliant !== true ||
    !Array.isArray(value.questionChecks) ||
    value.questionChecks.length !== ids.length ||
    ids.some(
      (id, i) =>
        !new RegExp(`^${id}[：:]\\s*\\S`).test(value.questionChecks[i] || ''),
    )
  )
    throw Error(
      '题目内容审核未通过或缺少逐项依据：' + (value?.reason || '缺少记录'),
    );
  for (const [field, min, max] of [
    ['workflowFeatures', rules.minFeatures, rules.maxFeatures],
    ['businessDetails', rules.minBusinessDetails, rules.maxBusinessDetails],
  ]) {
    const items = value[field];
    if (
      !Array.isArray(items) ||
      items.length < min ||
      items.length > max ||
      items.some((x) => typeof x !== 'string' || !x.trim()) ||
      new Set(items.map((x) => x.trim())).size !== items.length
    )
      throw Error(
        `题目内容审核 ${field} 需 ${min}–${max} 项真实且不重复的正文依据`,
      );
  }
}
