import workflow from '../rules/workflow.json' with { type: 'json' };

const fields = {
  scaffold: ['summary'],
  generate: ['prompt'],
  prepare: ['prompt'],
  next: ['prompt', 'reason'],
  'project-next': ['prompt', 'reason'],
  score: ['descriptions', 'other', 'processFindings', 'artifactFindings'],
};

export function writingInstructions(stage) {
  if (!fields[stage]) return '';
  return `表达要求只应用于 ${fields[stage].join('、')} 字段：\n${workflow.writingStyle.join('\n')}\n题目示例：在现有订单页面加上按状态筛选和分页，切换筛选时回到第一页，并补上空列表和末页的测试。\nBug 追问示例：订单列表切换到第二页后再按状态筛选，页面没有回到第一页，结果显示为空，把页码重置补上，再检查末页和空列表。\n点评示例：订单列表已经加上筛选和分页，但切换状态后仍停在原页码，筛选结果会显示为空，需要重置页码并补上对应测试。`;
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

export function proseIssues(text) {
  // Exact code/strings/URLs belong in inline code, not in prose rules.
  const prose = text.replace(/`[^`\r\n]+`/g, '代码');
  const issues = [];
  if (/\r|\n/.test(text)) issues.push('写成一段连贯的话，不换行列清单');
  if (/[“”‘’「」『』"]|(?<![A-Za-z])'|'(?![A-Za-z])/.test(prose))
    issues.push('去掉叙述中的引号，必要的代码字面量放在行内代码中');
  if (
    /可能(?!性)|也许|或许|大概|似乎|貌似|应该是|看起来|估计|猜测|竟然|居然|没想到|出乎意料|令人惊讶|不得不说|显而易见|不难发现|非常棒|太棒了|完美无缺|令人失望/.test(
      prose,
    )
  )
    issues.push('使用平淡语气，按证据写事实，缺少证据时写未验证或缺少记录');
  if (/[!！?？…]|\.\.\./.test(prose)) issues.push('不用感叹、反问或省略号');
  if (
    /^(?:[-*#]|\d+[.、])\s|(?:触发节点|实际行为|正确做法|业务影响|证据|When|What|Impact)\s*[:：]/i.test(
      prose,
    )
  )
    issues.push('自然表达，不使用分项标签或模板标题');
  return issues;
}

export function checkWriting(stage, value) {
  const result = { ...value },
    issues = [];
  for (const field of fields[stage] || []) {
    const texts = Array.isArray(value[field]) ? value[field] : [value[field]];
    const normalized = texts.map((text, i) => {
      const s = unwrapProse(text);
      for (const issue of proseIssues(s))
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

export function withProjectScope(prompt, directory) {
  const scope = `仅在 ${directory} 创建或修改本项目文件，后续沿用同一项目且不另建项目`;
  const s = unwrapProse(prompt);
  if (s.includes(scope)) return s;
  return s.replace(/[。.]$/, '') + '，' + scope + '。';
}

export const isPlainContinuation = (prompt) =>
  /^(?:请)?(?:继续|继续完成|continue)[。.!！]*$/i.test((prompt || '').trim());
