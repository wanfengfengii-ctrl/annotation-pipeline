import { createHash } from 'node:crypto';
import { failureKind } from './retry-policy.mjs';
import {
  validationRetryAllowed,
  historicalValidationRetryAllowed,
  blockedProjectRetryAllowed,
  stoppedCompletionRetryAllowed,
} from './project-recovery.mjs';
import { canPlanDisputedTurn } from './disputed-continuation.mjs';
import { selfHealConditions } from './recovery-conditions.mjs';

export const selfHealVersion = '2026-09-12.self-heal3';
export const selfHealDefaults = Object.freeze({
  intervalMs: 15000,
  confirmMs: 15000,
  retryDelayMs: 0,
  maxAttempts: null,
  maxRepairsPerDay: null,
});
export const hasRepairLimit = (value) => Number.isInteger(value) && value > 0;
export const attemptLimitReached = (i, config) =>
  hasRepairLimit(config.maxAttempts) && i.attempts >= config.maxAttempts;
export function currentFault(i, snapshot) {
  if (i.stage === 'scheduler')
    return !!(
      snapshot.health.supplyNeedsAction ||
      snapshot.health.stalled ||
      snapshot.health.underutilized
    );
  return snapshot.health.incidents?.some(
    (x) =>
      x.taskId === i.taskId &&
      x.turnId === i.turnId &&
      x.externalKey === i.externalKey &&
      faultSignature(x) === i.signature &&
      ['open', 'stalled_running'].includes(x.state),
  );
}
const unsuccessful = (j) =>
  ['failed', 'needs_input', 'uncertain', 'retry_intent'].includes(j.state);
// An unrelated console/release publication is not new evidence for a diagnosis
// that explicitly needs input. Eligibility is included so a newly available
// guarded recovery can reopen the incident without resetting its history.
export function recoveryEvidenceKey(i, snapshot) {
  const task = snapshot.tasks.find((t) => t.id === i.taskId);
  const turn = task?.turns.find((r) => r.id === i.turnId);
  return digest([
    selfHealConditions(i, {
      ...snapshot,
      recoveryRevision: null,
      config: { ...snapshot.config, recoveryRevision: null },
    }),
    recoveryAction(task, turn),
  ]);
}
const sameDiagnosisInputs = (j, key, evidenceKey, inputBlocked = false) =>
  j.conditionsKey === key ||
  ((j.state === 'needs_input' || inputBlocked) &&
    j.evidenceKey === evidenceKey);
const hasInputDiagnosis = (state, incidentId, evidenceKey) =>
  state.jobs.some(
    (j) =>
      j.incidentId === incidentId &&
      j.evidenceKey === evidenceKey &&
      j.state === 'needs_input',
  );
export function recoveryReviewMode(state, i, snapshot) {
  const key = selfHealConditions(i, snapshot);
  const evidenceKey = recoveryEvidenceKey(i, snapshot);
  const inputBlocked = hasInputDiagnosis(state, i.id, evidenceKey);
  const failures = state.jobs.filter(
    (j) =>
      j.incidentId === i.id &&
      sameDiagnosisInputs(j, key, evidenceKey, inputBlocked) &&
      unsuccessful(j),
  );
  if (failures.some((j) => j.mode === 'escalation')) return null;
  if (failures.length) return 'escalation';
  // Old diagnostics lack a conditions digest. Keep their history and review it
  // once under the new protocol, without resetting counters or copying patches.
  if (
    state.jobs.some(
      (j) => j.incidentId === i.id && !j.conditionsKey && unsuccessful(j),
    )
  )
    return 'escalation';
  return 'repair';
}
export const digest = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');
export const faultSignature = (i) =>
  digest([
    i.stage,
    failureKind(i.reason),
    String(i.reason)
      .replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, '<id>')
      .replace(/\b\d{10,}\b/g, '<time>'),
  ]);

export function recoveryAction(task, turn) {
  if (
    !task ||
    !turn ||
    task.closed ||
    task.turns.some((r) => r.status === 'running' || r.recoveryBlocked)
  )
    return null;
  if (turn.excluded || turn.receipt || turn.humanReview?.receipt) return null;
  if (
    validationRetryAllowed(task, turn) ||
    historicalValidationRetryAllowed(task, turn)
  )
    return 'retry-validation';
  if (
    turn.id === task.turns.at(-1)?.id &&
    (canPlanDisputedTurn(task, turn) ||
      (turn.status === 'review' && turn.automation?.nextError))
  )
    return 'retry-plan';
  if (
    stoppedCompletionRetryAllowed(task, turn) ||
    blockedProjectRetryAllowed(task, turn) ||
    (turn.status === 'failed' &&
      turn.projectRecovery?.state === 'blocked' &&
      turn.id === task.turns.at(-1)?.id)
  )
    return 'retry';
  return null;
}

export function isExternalBlock(task, turn, reason) {
  return !!(
    task?.closed ||
    turn?.excluded ||
    turn?.recoveryBlocked ||
    turn?.receipt ||
    turn?.humanReview?.receipt ||
    /禁止上传|原件缺失|原始轨迹缺失|摘要不符|身份冲突|无法自动恢复的排除项|验证码|额度耗尽|insufficient.quota|\b(?:401|403)\b|认证失败|API.?Key.*(?:无效|失效)/i.test(
      reason,
    )
  );
}

// Preserve incidents across changes to the latest turn. Only real delivery or
// verified independent continuation resolves a task incident, never a heartbeat.
export function reconcileSelfHeal(
  previous,
  snapshot,
  now = Date.now(),
  config = selfHealDefaults,
) {
  const state = structuredClone(
    previous || { version: selfHealVersion, incidents: {}, jobs: [] },
  );
  state.version = selfHealVersion;
  state.checkedAt = new Date(now).toISOString();
  state.incidents ||= {};
  state.jobs ||= [];
  const tasks = new Map(snapshot.tasks.map((t) => [t.id, t]));
  for (const issue of snapshot.health.incidents || []) {
    if (!['open', 'stalled_running'].includes(issue.state)) continue;
    const signature = faultSignature(issue),
      id = issue.id + ':' + signature.slice(0, 12);
    const old = state.incidents[id];
    state.incidents[id] = {
      ...old,
      id,
      taskId: issue.taskId,
      externalKey: issue.externalKey,
      turnId: issue.turnId,
      signature,
      stage: issue.stage,
      reason: issue.reason,
      firstSeenAt:
        old?.state === 'resolved'
          ? state.checkedAt
          : old?.firstSeenAt || state.checkedAt,
      observedAt: state.checkedAt,
      observations: (old?.observations || 0) + 1,
      state:
        old?.state === 'resolved'
          ? 'observing'
          : old?.state || (issue.state === 'open' ? 'ready' : 'observing'),
      attempts: old?.attempts || 0,
      baselineProgress: old?.baselineProgress || issue.lastProgressAt || null,
    };
  }
  // A supply or empty-slot failure has no turn yet; retain it as a system incident.
  if (
    snapshot.health.supplyNeedsAction ||
    snapshot.health.stalled ||
    snapshot.health.underutilized
  ) {
    const reason =
      snapshot.health.supplyFailure?.message ||
      snapshot.health.supplyFailure?.error ||
      snapshot.health.status;
    const issue = { stage: 'scheduler', reason },
      signature = faultSignature(issue),
      id = 'system:' + signature.slice(0, 12);
    const old = state.incidents[id];
    state.incidents[id] = {
      ...old,
      ...issue,
      id,
      signature,
      firstSeenAt: old?.firstSeenAt || state.checkedAt,
      observedAt: state.checkedAt,
      observations: (old?.observations || 0) + 1,
      state: old?.state || 'observing',
      attempts: old?.attempts || 0,
    };
  }
  for (const incident of Object.values(state.incidents)) {
    if (incident.state === 'resolved') continue;
    const task = tasks.get(incident.taskId),
      turn = task?.turns.find((r) => r.id === incident.turnId);
    const currentIssue = snapshot.health.incidents?.find(
      (x) =>
        x.id === incident.taskId + ':' + incident.turnId &&
        faultSignature(x) === incident.signature &&
        ['open', 'stalled_running'].includes(x.state),
    );
    const delivered =
      !currentIssue &&
      turn?.automation?.delivery?.value?.passed === true &&
      ['review', 'submitted'].includes(turn.status);
    const successor = task?.turns.find(
      (r) => r.id === turn?.projectRecovery?.nextTurnId,
    );
    const continued =
      incident.stage !== 'finalization' &&
      turn?.projectRecovery?.state === 'continued' &&
      successor &&
      (successor.promptId || successor.automation?.delivery?.value?.passed);
    const systemRecovered =
      !incident.taskId &&
      (incident.stage === 'upload'
        ? snapshot.health.externalResolvedIds?.includes(incident.externalKey)
        : incident.stage === 'api'
          ? !snapshot.health.observationFailed
          : !snapshot.health.needsAction && snapshot.health.active > 0);
    const progress =
      snapshot.health.progress?.[incident.taskId + ':' + incident.turnId];
    const moving =
      currentIssue?.state !== 'stalled_running' &&
      turn?.status === 'running' &&
      progress?.lastProgressAt &&
      Date.parse(progress.lastProgressAt) >
        Date.parse(incident.baselineProgress || incident.firstSeenAt);
    const conditionsKey = selfHealConditions(incident, snapshot);
    const evidenceKey = recoveryEvidenceKey(incident, snapshot);
    // Upgrade old rows only when their complete, original conditions still
    // match. Never attribute today's evidence to a different historical input.
    for (const job of state.jobs)
      if (
        job.incidentId === incident.id &&
        job.conditionsKey === conditionsKey &&
        !job.evidenceKey
      )
        job.evidenceKey = evidenceKey;
    const unchangedAttempt = state.jobs.findLast(
      (j) =>
        j.incidentId === incident.id &&
        sameDiagnosisInputs(
          j,
          conditionsKey,
          evidenceKey,
          hasInputDiagnosis(state, incident.id, evidenceKey),
        ) &&
        unsuccessful(j),
    );
    incident.conditionsKey = conditionsKey;
    incident.evidenceKey = evidenceKey;
    if (delivered || continued || systemRecovered) {
      incident.state = 'resolved';
      incident.resolvedAt = state.checkedAt;
      incident.result = delivered
        ? '原题交付通过'
        : continued
          ? '同项目已实际发送后续独立题，旧失败记录保留'
          : '调度已恢复实际执行';
    } else if (
      isExternalBlock(task, turn, incident.reason) ||
      (unchangedAttempt && isExternalBlock(task, turn, unchangedAttempt.reason))
    ) {
      incident.state = 'needs_input';
      incident.result =
        unchangedAttempt?.reason || '保留原件与现有排除，等待外部条件处理';
    } else if (
      moving ||
      (turn?.status === 'running' && incident.stage !== turn.stage)
    ) {
      incident.progressConfirmedAt =
        progress?.lastProgressAt || state.checkedAt;
      if (!['repairing', 'deploying'].includes(incident.state))
        incident.state = 'verifying';
    } else if (
      unchangedAttempt &&
      !['repairing', 'deploying'].includes(incident.state)
    ) {
      incident.state = recoveryReviewMode(state, incident, snapshot)
        ? 'escalation_ready'
        : 'needs_input';
      incident.result =
        incident.state === 'escalation_ready'
          ? '常规自动修复未完成，立即升级诊断，沿用失败证据和复核意见'
          : '升级诊断仍未完成，需要接手处理：' +
            (unchangedAttempt.reason || incident.reason);
      incident.previousJobId = unchangedAttempt.id;
    } else if (
      ['waiting_conditions', 'needs_input'].includes(incident.state) &&
      currentFault(incident, snapshot)
    ) {
      incident.state = attemptLimitReached(incident, config)
        ? 'needs_input'
        : 'ready';
    } else if (
      currentIssue &&
      attemptLimitReached(incident, config) &&
      ['verifying', 'retry_wait'].includes(incident.state) &&
      now - Date.parse(incident.repairedAt || incident.firstSeenAt) >=
        20 * 60000
    ) {
      incident.state = 'needs_input';
      incident.result = '同一故障已用完自动修复次数，原进度和诊断保留';
    } else if (
      incident.state === 'observing' &&
      incident.observations >= 2 &&
      now - Date.parse(incident.firstSeenAt) >= config.confirmMs
    )
      incident.state = 'ready';
  }
  return state;
}

export function nextSelfHealAction(
  state,
  snapshot,
  now = Date.now(),
  config = selfHealDefaults,
) {
  if (!snapshot.config.enabled || !snapshot.config.autoContinue) return null;
  if (state.activeJob) return null;
  const priority = (i) =>
    i.stage === 'api'
      ? 2
      : Number(
          snapshot.health.incidents?.some(
            (x) =>
              x.id === i.taskId + ':' + i.turnId &&
              x.state === 'stalled_running',
          ),
        );
  for (const i of Object.values(state.incidents).sort(
    (a, b) =>
      priority(b) - priority(a) ||
      Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt),
  )) {
    if (
      ![
        'ready',
        'retry_wait',
        'verifying',
        'escalation_ready',
        'needs_input',
      ].includes(i.state) ||
      attemptLimitReached(i, config) ||
      !currentFault(i, snapshot)
    )
      continue;
    if (
      i.state !== 'escalation_ready' &&
      i.nextAt &&
      now < Date.parse(i.nextAt)
    )
      continue;
    const task = snapshot.tasks.find((t) => t.id === i.taskId),
      turn = task?.turns.find((r) => r.id === i.turnId);
    if (isExternalBlock(task, turn, i.reason)) continue;
    // Existing progressing recovery owns the turn. Do not spend another model call.
    if (
      turn?.status === 'running' &&
      snapshot.health.incidents?.find((x) => x.id === task.id + ':' + turn.id)
        ?.state !== 'stalled_running'
    )
      continue;
    if (
      turn?.status === 'queued' &&
      turn.automation?.runtimeRecovery?.state !== 'paused'
    )
      continue;
    if (
      i.state === 'verifying' &&
      i.progressConfirmedAt &&
      now - Date.parse(i.progressConfirmedAt) < 20 * 60000
    )
      continue;
    if (
      state.jobs.some(
        (j) =>
          j.signature === i.signature &&
          j.incidentId !== i.id &&
          [
            'running',
            'deploying',
            'verifying',
            'published',
            'retried',
          ].includes(j.state),
      )
    )
      continue;
    const action = recoveryAction(task, turn);
    // Known transport failures may use one existing guarded retry. Other errors
    // require diagnosis and a published change before another attempt.
    if (action && failureKind(i.reason) === 'transport' && !i.directRetryAt)
      return { kind: 'retry', incidentId: i.id, action };
    const mode = recoveryReviewMode(state, i, snapshot);
    if (!mode) continue;
    const prior = state.jobs.findLast(
      (j) =>
        j.incidentId === i.id &&
        sameDiagnosisInputs(
          j,
          selfHealConditions(i, snapshot),
          recoveryEvidenceKey(i, snapshot),
          hasInputDiagnosis(state, i.id, recoveryEvidenceKey(i, snapshot)),
        ) &&
        unsuccessful(j),
    );
    if (prior && isExternalBlock(task, turn, prior.reason)) continue;
    if (
      hasRepairLimit(config.maxRepairsPerDay) &&
      state.jobs.filter((j) => now - Date.parse(j.startedAt) < 24 * 60 * 60000)
        .length >= config.maxRepairsPerDay
    )
      continue;
    return { kind: 'repair', mode, incidentId: i.id };
  }
  return null;
}
