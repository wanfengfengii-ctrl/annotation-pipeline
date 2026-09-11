import rules from '../rules/question-writing.json' with { type: 'json' };
export { rules as questionRules };
export const isBugRepair = (options = {}) =>
  options.category === 'Bug 修复' ||
  options.repair === true ||
  options.legacyRepair === true;
export const questionHasTitle = (options = {}) =>
  !isBugRepair(options) &&
  (options.category || '0-1 代码生成') === '0-1 代码生成';

export function questionInstructions(options = {}) {
  const { legacyRepair = false } = options;
  return (
    `题目内容与格式规则（${rules.version}，表达版本 ${rules.languageVersion}，优先于旧题示例及出题范围中的冲突要求）：\n${rules.instructions.join('\n')}` +
    `\n${rules.bugRepairInstructions.join('\n')}` +
    (isBugRepair(options)
      ? '\n当前题型为 Bug 修复，prompt 必须直接从问题现象开始，不得加项目名称或标题。'
      : options.category && !questionHasTitle(options)
        ? `\n当前题型为 ${options.category}，prompt 直接写需求正文，不得加项目名称、标题或编号。`
        : '') +
    (legacyRepair
      ? '\n本轮范围继承说明：执行器已核验，本轮是网页规则启用前已实际执行的历史题目在原会话中的真实 Bug 修复。沿用原题面向的用户、既有业务操作和界面形态；web 和 layout 按原题范围核验，原题无网页时写明不适用，不能强行新增网页、虚构浏览器操作或改变原题验收范围。其余格式、语气、4–6 项受影响操作、1–2 项细节、禁出、雷同、难度及真实复现审核全部保留。此范围继承仅适用于本次关联修复，不适用于首题、0-1、Feature、理解或重构独立新题。'
      : '')
  );
}

export function questionParts(text, options = {}) {
  const lines = text.trim().replace(/\r\n?/g, '\n').split('\n');
  const title = questionHasTitle(options) ? lines.shift() || '' : '';
  const paragraphs = lines.map((s) => s.trim()).filter(Boolean);
  const body = paragraphs.join('\n');
  return {
    title,
    paragraphs,
    body,
    bodyLength: [...body.replace(/\s/g, '')].length,
  };
}

export function questionFormatIssues(text, options = {}) {
  const repair = isBugRepair(options);
  const hasTitle = questionHasTitle(options);
  const { title, paragraphs, body, bodyLength } = questionParts(text, options);
  const issues = [];
  if (
    hasTitle &&
    (!title ||
      /^(?:\d+[、.．)）]|第[\d一二三四五六七八九十百]+题|[#*])/.test(title))
  )
    issues.push('首行只写项目名称，不加题目编号或标题标记');
  if (paragraphs.length < 1 || paragraphs.length > 2)
    issues.push(
      !hasTitle
        ? '本题直接写 1 至 2 个自然段，不加标题或清单'
        : '标题下面写 1 至 2 个自然段，不分行列清单',
    );
  if (
    !hasTitle &&
    paragraphs.length > 1 &&
    paragraphs[0].length < 80 &&
    !/[。！？；，,:：]/.test(paragraphs[0])
  )
    issues.push('只有 0-1 代码生成需要标题，本题不写独立项目名称或标题');
  if (
    repair &&
    /面向.{0,50}(?:开发者|用户|人员)|边界问题|落实|核验|既有.*语义|改行/.test(
      body,
    )
  )
    issues.push(
      'Bug 修复用日常说话的方式描述问题和预期，不用面向某某、边界问题、落实、核验、既有语义等正式表达',
    );
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
  const applicable = isBugRepair(options)
    ? {
        ...criteria,
        audience:
          '沿用原题的实际使用场景，说明出了什么问题，不要求重新介绍面向谁',
        language:
          'Bug 修复没有项目名称或标题，直接描述问题、复现条件和预期，像同事接着聊项目，避免正式公文措辞；不编造人工经历，必要数字和条件完整保留。' +
          criteria.language,
      }
    : questionHasTitle(options)
      ? {
          ...criteria,
          language:
            '0-1 代码生成首行写无编号的项目名称，正文直接描述需求。' +
            criteria.language,
        }
      : {
          ...criteria,
          language:
            '本题没有项目名称、标题或编号，直接写 1 至 2 段可执行的需求正文。' +
            criteria.language,
        };
  return `${questionInstructions(options)}\n独立审核候选实际 prompt 的内容与格式，不能只相信作者自述。原始目标提供业务范围和事实依据，题目表达、字数和内部去重只审查将要发送的候选 prompt；不能因原目标中的重复已被候选合并而继续拒绝。questionCompliant 仅在全部适用标准通过时为 true；questionChecks 按下列 ID 顺序逐项返回 ID：通过，正文依据 或 ID：不通过，失败原因，缺失明确写不通过及缺少的依据。表达难懂归入 language，不因必要业务术语本身否定功能或难度；其他项也须明确核对并给出通过或不通过，便于仅表达失败时按原范围修订。workflowFeatures 列出正文中 4 至 6 项相互关联的功能或已有业务操作，businessDetails 列出 1 至 2 个正文中的具体业务细节；数量不足或超出时如实返回，禁止编造凑数。reason 说明不合格项，questionCompliant=false 时 allowed 必须为 false。\n${Object.entries(
    applicable,
  )
    .map(([id, description]) => `${id}：${description}`)
    .join('\n')}`;
}

export function assertQuestionAudit(value) {
  const ids = Object.keys(rules.criteria);
  if (
    !Array.isArray(value?.wordingRequirements) ||
    value.wordingRequirements.length < 1 ||
    value.wordingRequirements.some((x) => typeof x !== 'string' || !x.trim()) ||
    !Array.isArray(value?.wordingDuplicatePairs) ||
    value.wordingDuplicatePairs.length
  )
    throw Error(
      '题目内容审核存在话语重复或缺少逐句去重依据：' +
        (value?.wordingDuplicatePairs?.join('；') || '缺少记录'),
    );

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
