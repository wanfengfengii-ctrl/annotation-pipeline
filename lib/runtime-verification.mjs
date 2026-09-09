export const runtimeVersion = '2026-09-09.runtime1';
// Descriptive IDs become log basenames; keep them bounded and path-safe.
export const runtimeCheckIdPattern = '^[a-z][a-z0-9_-]{0,127}$';
const nonempty = (x) => typeof x === 'string' && !!x.trim();
export function validateRuntimePlan(value) {
  if (
    !value ||
    !nonempty(value.summary) ||
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > 8
  )
    throw Error('独立验收计划须包含 1–8 个实际执行步骤');
  const ids = new Set();
  for (const c of value.checks) {
    if (
      !c ||
      typeof c.id !== 'string' ||
      !new RegExp(runtimeCheckIdPattern).test(c.id) ||
      ids.has(c.id) ||
      !['setup', 'acceptance', 'reproduction'].includes(c.kind) ||
      !['command', 'expected', 'requirement', 'codeEvidence'].every((k) =>
        nonempty(c[k]),
      ) ||
      c.command.length > 24000 ||
      !Number.isInteger(c.timeoutSeconds) ||
      c.timeoutSeconds < 1 ||
      c.timeoutSeconds > 300
    )
      throw Error(
        `独立验收步骤格式无效（${c?.id || '缺少 id'}）：id 须为 1–128 位小写字母、数字、下划线或连字符且以字母开头，不能重复；步骤字段须完整，命令最多 24000 字，每步时限为 1–300 秒整数`,
      );
    ids.add(c.id);
  }
  if (!value.checks.some((c) => c.kind === 'acceptance'))
    throw Error('独立验收不能省略原题验收');
  if (value.checks.reduce((n, c) => n + c.timeoutSeconds, 0) > 900)
    throw Error('独立验收总时限不能超过 15 分钟');
  return value;
}
export function validateRuntimeVerdict(value) {
  if (
    !value ||
    !nonempty(value.summary) ||
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > 8
  )
    throw Error('独立验收诊断缺失');
  for (const c of value.checks) {
    if (
      !nonempty(c.id) ||
      !['passed', 'reproduced', 'not_reproduced', 'blocked'].includes(
        c.outcome,
      ) ||
      !nonempty(c.observed) ||
      !Number.isInteger(c.evidenceLine) ||
      c.evidenceLine < 1
    )
      throw Error('独立验收诊断格式无效');
  }
  return value;
}
export function runtimeRepairEvidence(turn) {
  const r = turn.automation?.runtimeVerification;
  return (
    r?.version === runtimeVersion &&
    r.executed === true &&
    r.status === 'bugs' &&
    !!r.reportPath &&
    !!r.reportSha256 &&
    Array.isArray(r.checks) &&
    r.checks.some(
      (c) =>
        c.outcome === 'reproduced' &&
        c.kind !== 'setup' &&
        c.exitCode === 1 &&
        !c.timedOut &&
        !c.sourceChanged &&
        !!c.logPath &&
        !!c.logSha256 &&
        !!c.requirement &&
        !!c.codeEvidence,
    )
  );
}
