export const runtimeRecoveryVersion = '2026-09-12.runtime-recovery1';
const stages = ['runtime-plan', 'runtime-running', 'runtime-diagnose'];
const receipt = (value) =>
  value &&
  typeof value.path === 'string' &&
  /^[a-f0-9]{64}$/.test(value.sha256 || '');
export function runtimeRecoveryCandidate({
  previous,
  plan,
  product,
  progress,
  error,
  stage,
  turnId,
  now = Date.now(),
}) {
  if (!stages.includes(stage) || (!receipt(plan) && !receipt(product)))
    return null;
  const completedIds = Array.isArray(progress?.completedIds)
    ? progress.completedIds
    : [];
  const advanced = completedIds.some(
    (id) => !previous?.completedIds?.includes(id),
  );
  const stalledAttempts = advanced ? 0 : (previous?.stalledAttempts || 0) + 1;
  return {
    version: runtimeRecoveryVersion,
    turnId,
    state: stalledAttempts >= 3 ? 'paused' : 'waiting',
    plan,
    product,
    progress: receipt(progress) ? progress : undefined,
    completedIds,
    stalledAttempts,
    producedOutput: !!progress?.producedOutput,
    stage,
    lastError: String(error || '').slice(0, 4000),
    retryAt: new Date(
      now + Math.min(120, 30 * 2 ** stalledAttempts) * 1000,
    ).toISOString(),
  };
}
export function runtimeRecoveryEligible(turn) {
  const recovery = turn?.automation?.runtimeRecovery;
  return !!(
    recovery?.version === runtimeRecoveryVersion &&
    recovery.turnId === turn.id &&
    ['waiting', 'paused'].includes(recovery.state) &&
    (receipt(recovery.plan) || receipt(recovery.product)) &&
    stages.includes(turn.stage) &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    turn.promptId &&
    turn.sessionId &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    !turn.excluded &&
    !turn.recoveryBlocked &&
    !turn.automation?.submittedPolicyEvidence
  );
}
export function runtimeRecoveryDue(turn, now = Date.now()) {
  const recovery = turn?.automation?.runtimeRecovery;
  if (!recovery || recovery.state === 'complete') return true;
  return (
    runtimeRecoveryEligible(turn) &&
    recovery.state === 'waiting' &&
    now >= Date.parse(recovery.retryAt)
  );
}
export function runtimeRecoveryLabel(turn) {
  if (turn?.status !== 'queued' || !runtimeRecoveryEligible(turn)) return null;
  return turn.automation.runtimeRecovery.state === 'paused'
    ? '验收待处理'
    : '验收待续跑';
}
