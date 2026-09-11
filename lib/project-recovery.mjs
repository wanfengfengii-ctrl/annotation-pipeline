import workflow from '../rules/workflow.json' with { type: 'json' };

export const projectRecoveryVersion = '2026-09-11.same-project1';
export const replacementCategories = ['0-1 代码生成', 'Feature 迭代'];
export function wasSent(turn) {
  // An uncertain reserved call consumes quota too. Never infer a send from a
  // stage name: preparation and failed context checks can reach those names.
  return !!(turn.promptId || turn.sessionId || turn.claudeAttempts?.length);
}
export function sentProjectCounts(task) {
  return Object.fromEntries(
    replacementCategories.map((category) => [
      category,
      task.turns.filter(
        (r) =>
          !r.repairOf &&
          !r.continuationOf &&
          r.category === category &&
          wasSent(r),
      ).length,
    ]),
  );
}
export function projectQuotaComplete(task) {
  const counts = sentProjectCounts(task);
  return replacementCategories.every(
    (c) => counts[c] >= workflow.projectLimits[c],
  );
}
export function projectRecoveryReady(turn) {
  const r = turn?.projectRecovery;
  return !!(
    r?.version === projectRecoveryVersion &&
    r.turnId === turn.id &&
    r.state === 'continued' &&
    r.nextTurnId &&
    r.idleVerified === true &&
    r.sourceSnapshot?.verified &&
    /^[a-f0-9]{64}$/.test(r.sourceSnapshot.manifestSha256 || '')
  );
}
export function unsentFailure(turn) {
  return (
    turn?.status === 'failed' &&
    !wasSent(turn) &&
    !turn.recoveryBlocked &&
    ['context', 'scaffold', 'prepare', 'policy', 'snapshot'].includes(
      turn.stage,
    )
  );
}
export function projectRecoveryDue(task, config, now = Date.now()) {
  const turn = task.turns.at(-1);
  if (
    !task.projectSeries ||
    task.closed ||
    !config.autoContinue ||
    projectQuotaComplete(task) ||
    !turn ||
    task.turns.some(
      (r) => r.recoveryBlocked || ['queued', 'running'].includes(r.status),
    ) ||
    turn.gatewayRecovery?.nextTurnId ||
    turn.projectRecovery?.nextTurnId
  )
    return false;
  const record = turn.projectRecovery;
  if (
    (record?.attempts || 0) >= 3 ||
    now < Date.parse(record?.retryAt || '1970-01-01')
  )
    return false;
  if (unsentFailure(turn)) return true;
  if (
    turn.status === 'failed' &&
    turn.executionOutcome === 'error' &&
    turn.traceExport?.verified &&
    turn.promptId &&
    turn.sessionId
  )
    return true;
  if (
    turn.status === 'failed' &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    (turn.stageRecovery?.attempts || 0) >= 2
  )
    return !!turn.automation?.submittedPolicyEvidence;
  // A finished question/session is not a finished project. Runtime blocks and
  // unresolved Bugs still need evidence; they are never relabelled as new work.
  return (
    ['review', 'submitted'].includes(turn.status) &&
    !turn.excluded &&
    turn.automation?.archive &&
    turn.automation?.runtimeVerification?.status === 'passed' &&
    (['complete', 'needs_input'].includes(
      turn.automation?.next?.value?.action,
    ) ||
      !!turn.automation?.nextError)
  );
}

export function validationRetryAllowed(task, turn) {
  return !!(
    turn &&
    task.turns.at(-1)?.id === turn.id &&
    !task.closed &&
    !turn.excluded &&
    !turn.receipt &&
    !turn.humanReview?.receipt &&
    !turn.recoveryBlocked &&
    !turn.automation?.submittedPolicyEvidence &&
    !turn.projectRecovery?.nextTurnId &&
    (turn.status === 'failed' ||
      (turn.status === 'queued' && turn.projectRetry)) &&
    turn.executionOutcome === 'complete' &&
    turn.traceExport?.verified &&
    turn.permissionAudit?.passed &&
    turn.promptId &&
    turn.sessionId &&
    task.turns.every(
      (r) =>
        r.id === turn.id ||
        (!r.recoveryBlocked && !['running', 'queued'].includes(r.status)),
    )
  );
}

export function postprocessRetryDue(task, config, now = Date.now()) {
  const r = task.turns.at(-1);
  return !!(
    task.projectSeries &&
    !task.closed &&
    config.autoContinue &&
    r &&
    r.status === 'failed' &&
    !r.excluded &&
    !r.recoveryBlocked &&
    r.executionOutcome === 'complete' &&
    r.traceExport?.verified &&
    r.permissionAudit?.passed &&
    [
      'runtime-plan',
      'runtime-running',
      'runtime-diagnose',
      'score',
      'delivery',
    ].includes(r.stageRecovery?.originalStage || r.stage) &&
    (r.stageRecovery?.attempts || 0) < 2 &&
    now >= Date.parse(r.stageRecovery?.retryAt || '1970-01-01') &&
    !task.turns.some(
      (x) => x.recoveryBlocked || ['queued', 'running'].includes(x.status),
    )
  );
}
