import workflow from '../rules/workflow.json' with { type: 'json' };
import { formatQuestionText } from './question-text.mjs';
import {
  questionInstructions,
  questionFormatIssues,
  questionParts,
} from './question-writing.mjs';

const questionStages = ['generate', 'prepare', 'next', 'project-next'];

const fields = {
  scaffold: ['summary'],
  generate: ['prompt'],
  prepare: ['prompt'],
  next: ['prompt', 'reason'],
  'project-next': ['prompt', 'reason'],
  score: ['descriptions', 'other', 'processFindings', 'artifactFindings'],
};

export function writingInstructions(stage, questionContext = {}) {
  if (!fields[stage]) return '';
  const common = `表达要求只应用于 ${fields[stage].join('、')} 字段：\n${workflow.writingStyle.join('\n')}`;
  return questionStages.includes(stage)
    ? `${common}\nprompt 单独遵守下列题目格式，reason 仍是一段平淡的依据说明。complete、needs_input 或已禁用的 continue 动作没有新题，prompt 只写无。\n${questionInstructions(questionContext)}`
    : common;
}

// Only remove a quote pair wrapping the whole prose; never strip code literals.
export function unwrapProse(text) {
  let s = text.trim();
  const pairs = [
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ];
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of pairs) {
      if (
        s.startsWith(a) &&
        s.endsWith(b) &&
        s.length > 2 &&
        !s.slice(1, -1).includes(b)
      ) {
        s = s.slice(1, -1).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

export function proseIssues(text, { paragraphs = false } = {}) {
  // Exact code/strings/URLs belong in inline code, not in prose rules.
  const prose = text.replace(/`[^`\r\n]+`/g, '代码');
  const issues = [];
  if (!paragraphs && /\r|\n/.test(text))
    issues.push('写成一段连贯的话，不换行列清单');
  if (/[“”‘’「」『』"]|(?<![A-Za-z])'|'(?![A-Za-z])/.test(prose))
    issues.push('去掉叙述中的引号，必要的代码字面量放在行内代码中');
  const matchedTerms = [
    ...new Set(
      prose.match(
        /可能(?!性)|也许|或许|大概|似乎|貌似|应该是|看起来|估计|猜测|竟然|居然|没想到|出乎意料|令人惊讶|不得不说|显而易见|不难发现|非常棒|太棒了|完美无缺|令人失望/g,
      ) || [],
    ),
  ];
  if (matchedTerms.length)
    issues.push(
      `使用平淡语气，按证据写事实，缺少证据时写未验证或缺少记录；命中词：${matchedTerms.join('、')}，否定句中的这些词也需按原始证据重新表述，不直接删词或改变事实的确定程度`,
    );
  if (/[!！?？…]|\.\.\./.test(prose)) issues.push('不用感叹、反问或省略号');
  if (
    /^(?:[-*#]|\d+[.、])\s|(?:触发节点|实际行为|正确做法|业务影响|证据|When|What|Impact)\s*[:：]/i.test(
      prose,
    )
  )
    issues.push('自然表达，不使用分项标签或模板标题');
  return issues;
}

export function questionIssues(text, options = {}) {
  const { title, body } = questionParts(text, options);
  return [
    ...questionFormatIssues(text, options),
    ...proseIssues(title),
    ...proseIssues(body, { paragraphs: true }),
  ];
}

export function checkWriting(stage, value) {
  const result = { ...value },
    issues = [];
  for (const field of fields[stage] || []) {
    const texts = Array.isArray(value[field]) ? value[field] : [value[field]];
    const normalized = texts.map((text, i) => {
      const question = field === 'prompt' && questionStages.includes(stage);
      const s = question
        ? formatQuestionText(unwrapProse(text))
        : unwrapProse(text);
      const noQuestion =
        question &&
        ['next', 'project-next'].includes(stage) &&
        ['complete', 'needs_input', 'continue'].includes(value.action);
      const found = noQuestion
        ? s === '无'
          ? []
          : ['没有新题时 prompt 写无']
        : question
          ? questionIssues(s, {
              category: value.category,
              repair: value.action === 'repair',
            })
          : proseIssues(s);
      for (const issue of found)
        issues.push(
          `${field}${Array.isArray(value[field]) ? '[' + i + ']' : ''}：${issue}`,
        );
      return s;
    });
    result[field] = Array.isArray(value[field]) ? normalized : normalized[0];
  }
  return { value: result, issues };
}

export function assertWritingRevision(stage, before, after) {
  for (const key of Object.keys(before)) {
    if (
      !(fields[stage] || []).includes(key) &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key])
    )
      throw Error(`表达修订不得改动 ${stage}.${key}`);
  }
}

export const isPlainContinuation = (prompt) =>
  /^(?:请)?(?:继续|继续完成|continue)[。.!！]*$/i.test((prompt || '').trim());
