export const runtimeVersion = '2026-09-09.runtime1';
export const runtimeMaxChecks = 64;
export const defaultRuntimeLimits = Object.freeze({
  totalTimeoutSeconds: 1800,
  stepTimeoutSeconds: 600,
  maxChecks: runtimeMaxChecks,
});
export function validateRuntimeLimits(value = defaultRuntimeLimits) {
  if (
    !value ||
    !Number.isInteger(value.totalTimeoutSeconds) ||
    value.totalTimeoutSeconds < 60 ||
    value.totalTimeoutSeconds > 7200 ||
    !Number.isInteger(value.stepTimeoutSeconds) ||
    value.stepTimeoutSeconds < 1 ||
    value.stepTimeoutSeconds > 1800 ||
    value.stepTimeoutSeconds > value.totalTimeoutSeconds ||
    !Number.isInteger(value.maxChecks) ||
    value.maxChecks < 1 ||
    value.maxChecks > runtimeMaxChecks
  )
    throw Error(
      '验收预算配置无效：总时限1–120分钟，单步最多30分钟，用例最多64项',
    );
  return { ...value };
}
const planLimits = (value) =>
  value?.limits
    ? validateRuntimeLimits(value.limits)
    : { totalTimeoutSeconds: 900, stepTimeoutSeconds: 300, maxChecks: 8 };
// Descriptive IDs become log basenames; keep them bounded and path-safe.
export const runtimeCheckIdPattern = '^[a-z][a-z0-9_-]{0,127}$';
const nonempty = (x) => typeof x === 'string' && !!x.trim();
export function runtimeBudgetRepairBase(prior) {
  if (
    prior?.issues?.length !== 1 ||
    !/^独立验收总时限不能超过 [\d.]+ 分钟$/.test(prior.issues[0].message)
  )
    return null;
  const base = prior.plan?.value;
  try {
    validateRuntimePlan({
      ...base,
      checks: base.checks.map((check) => ({ ...check, timeoutSeconds: 1 })),
    });
  } catch {
    return null;
  }
  return structuredClone(base);
}
export function applyRuntimeBudgetRepair(base, patch) {
  const limits = planLimits(base);
  if (
    !patch ||
    typeof patch !== 'object' ||
    Array.isArray(patch) ||
    Object.keys(patch).length !== 1 ||
    !Array.isArray(patch.timeouts) ||
    patch.timeouts.length !== base.checks.length
  )
    throw Error('验收预算修订只能返回每个原步骤的 id 和 timeoutSeconds');
  const ids = new Set(base.checks.map((check) => check.id));
  const timeouts = new Map();
  for (const item of patch.timeouts) {
    if (
      !item ||
      Object.keys(item).length !== 2 ||
      !ids.has(item.id) ||
      timeouts.has(item.id) ||
      !Number.isInteger(item.timeoutSeconds) ||
      item.timeoutSeconds < 1 ||
      item.timeoutSeconds > limits.stepTimeoutSeconds
    )
      throw Error('验收预算修订不能增删或重复步骤，也不能修改其他字段');
    timeouts.set(item.id, item.timeoutSeconds);
  }
  const value = structuredClone(base);
  for (const check of value.checks)
    check.timeoutSeconds = timeouts.get(check.id);
  return validateRuntimePlan(value);
}
export function validateRuntimePlan(value) {
  const limits = planLimits(value);
  if (
    !value ||
    !nonempty(value.summary) ||
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > limits.maxChecks
  )
    throw Error(`独立验收计划须包含 1–${limits.maxChecks} 个实际执行步骤`);
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
      c.timeoutSeconds > limits.stepTimeoutSeconds
    )
      throw Error(
        `独立验收步骤格式无效（${c?.id || '缺少 id'}）：id 须为 1–128 位小写字母、数字、下划线或连字符且以字母开头，不能重复；步骤字段须完整，命令最多 24000 字，每步时限为 1–${limits.stepTimeoutSeconds} 秒整数`,
      );
    ids.add(c.id);
  }
  if (!value.checks.some((c) => c.kind === 'acceptance'))
    throw Error('独立验收不能省略原题验收');
  if (
    value.checks.reduce((n, c) => n + c.timeoutSeconds, 0) >
    limits.totalTimeoutSeconds
  )
    throw Error(
      `独立验收总时限不能超过 ${limits.totalTimeoutSeconds / 60} 分钟`,
    );
  return value;
}
export function validateRuntimeVerdict(value) {
  if (
    !value ||
    !nonempty(value.summary) ||
    !Array.isArray(value.checks) ||
    !value.checks.length ||
    value.checks.length > runtimeMaxChecks
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
