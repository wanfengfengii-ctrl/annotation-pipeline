export const retryPolicyVersion = '2026-09-12.failure-scopes1';

export function failureKind(error = '') {
  const text = String(error);
  const kinds = [
    ['authentication', /\b(?:401|403)\b|api.?key|认证|鉴权|未登录/i],
    [
      'transport',
      /\b(?:429|502|503|504)\b|network|ECONN|fetch failed|网关|网络|连接失败/i,
    ],
    ['timeout', /超时|timeout|timed.out|无有效进展|no.progress/i],
    ['locator', /locator|selector|定位器|选择器|流程定位|多个匹配|控件.*定位/i],
    ['cleanup', /清理|cleanup/i],
    ['source-binding', /摘要|hash|manifest|基线|源码.*变化/i],
    [
      'dependency',
      /依赖|module.not.found|cannot.find.module|importerror|环境准备/i,
    ],
    ['resource', /内存|OOM|ENOSPC|日志超限|资源不足/i],
    ['syntax', /syntax|语法|未调用|入口.*调用|空日志|没有.*输出/i],
    ['score-evidence', /证据|引用|行号|空行/i],
    ['wording', /表达|格式|口语|字数|题面|描述/i],
    ['policy', /审核|难度|禁出|雷同|重复|题型/i],
  ];
  return (
    kinds.find(([, expression]) => expression.test(text))?.[0] || 'unclassified'
  );
}
export function failureScope({
  stage = '',
  error = '',
  revision = retryPolicyVersion,
} = {}) {
  return `${String(revision).slice(0, 160)}:${String(stage).replace(/^runtime-.*/, 'runtime')}:${failureKind(error)}`;
}
export function retryCount(record, context) {
  return (
    record?.retryBudgets?.find((b) => b.scope === failureScope(context))
      ?.attempts || 0
  );
}
export function retryBudgets(record, context, { reset = false } = {}) {
  const scope = failureScope(context);
  return [
    ...(record?.retryBudgets || []).filter((b) => b.scope !== scope),
    {
      scope,
      attempts: reset ? 0 : retryCount(record, context) + 1,
      updatedAt: new Date().toISOString(),
    },
  ].slice(-100);
}
