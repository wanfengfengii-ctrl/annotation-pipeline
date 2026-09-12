import { failureKind } from './retry-policy.mjs';
const clip = (v, n = 800) => String(v || '').slice(0, n);
export function rejectedCandidate(
  draft,
  reason,
  audit,
  now = new Date().toISOString(),
) {
  return {
    ...draft,
    reason,
    rejectedAt: now,
    rejectionKind: audit?.value?.duplicateTaskIds?.length
      ? 'duplicate'
      : audit?.value?.matchedRuleIds?.length
        ? 'forbidden'
        : failureKind(reason),
  };
}
export function candidateFeedback(state) {
  return (state.rejectedDrafts || []).slice(-6).map((d) => ({
    goal: clip(d.generated?.value?.prompt),
    category: d.generated?.value?.category,
    kind: d.rejectionKind || failureKind(d.reason),
    reason: clip(d.reason),
  }));
}
export function projectCapabilities(task) {
  const r = [...(task.turns || [])]
    .reverse()
    .find((r) => r.automation?.runtimeVerification?.reportSha256);
  if (!r) return null;
  const report = r.automation.runtimeVerification;
  return {
    taskId: task.id,
    turnId: r.id,
    reportSha256: report.reportSha256,
    factsSha256: r.automation.reviewFacts?.sha256 || null,
    source: report.source
      ? {
          files: report.source.files?.length || 0,
          reportPath: report.reportPath,
        }
      : null,
    checks: (report.checks || [])
      .filter((c) => c.kind !== 'setup')
      .map((c) => ({
        id: c.id,
        requirement: clip(c.requirement),
        outcome: c.outcome,
        observed: clip(c.observed),
      })),
    note: '对应指定报告和源码的历史能力摘要；读取实际源码核对变化。仅 reproduced 可作为 Bug 依据，不能将静态检查或摘要视为新复现。',
  };
}
