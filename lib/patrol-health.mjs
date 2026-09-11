import { projectQuotaComplete } from './project-recovery.mjs';

// Health of production is separate from API/process liveness. This ledger is
// observational: it cannot retry work, change scores or close native sessions.
export function patrolHealth({
  tasks,
  runner,
  config,
  previous = {},
  now = Date.now(),
}) {
  const at = new Date(now).toISOString();
  const scheduler = runner?.scheduler || {};
  const projects = tasks.filter(
    (t) => t.projectSeries && !t.closed && !projectQuotaComplete(t),
  );
  const active = Number(scheduler.active || 0);
  const enabled = config.enabled === true && config.autoContinue === true;
  const idle = enabled && projects.length > 0 && active === 0;
  const idleSince = idle ? previous.idleSince || at : null;
  const consecutiveIdle = idle ? (previous.consecutiveIdle || 0) + 1 : 0;
  const stalled =
    idle && (consecutiveIdle >= 2 || now - Date.parse(idleSince) >= 15 * 60000);
  const incidents = [];
  for (const task of projects) {
    const turn = task.turns.at(-1);
    if (!turn || turn.status !== 'failed') continue;
    const id = task.id + ':' + turn.id;
    const before = previous.incidents?.find((i) => i.id === id);
    const reason =
      turn.projectRecovery?.reason ||
      turn.error ||
      '失败原因未记录，需读取本轮日志';
    incidents.push({
      id,
      taskId: task.id,
      turnId: turn.id,
      title: task.title.split(/[：:]/)[0],
      stage: turn.stage,
      state: 'open',
      reason,
      firstSeenAt: before?.firstSeenAt || at,
      observations: (before?.observations || 0) + 1,
      unchanged: before?.reason === reason && before?.stage === turn.stage,
      retryAt:
        turn.projectRecovery?.retryAt || turn.stageRecovery?.retryAt || null,
      recoveryAttempts: turn.projectRecovery?.attempts || 0,
      validationAttempts: turn.stageRecovery?.attempts || 0,
      owner: before?.owner || null,
      action: before?.action || null,
      nextCheck: before?.nextCheck || null,
      evidence: before?.evidence || null,
    });
  }
  const latestCompleted =
    tasks
      .flatMap((t) => t.turns)
      .filter(
        (r) =>
          ['review', 'submitted'].includes(r.status) &&
          r.automation?.delivery?.value?.passed === true,
      )
      .map((r) => r.finishedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  return {
    version: '2026-09-12.patrol-health1',
    checkedAt: at,
    enabled,
    active,
    effective: scheduler.effective ?? null,
    apiHeartbeat: runner?.heartbeat || null,
    unfinishedProjects: projects.length,
    queued: projects.reduce(
      (n, t) => n + t.turns.filter((r) => r.status === 'queued').length,
      0,
    ),
    idleSince,
    consecutiveIdle,
    stalled,
    latestCompleted,
    needsAction: enabled && (stalled || incidents.length > 0),
    status: !enabled
      ? 'paused'
      : stalled
        ? 'stalled'
        : incidents.length
          ? 'unresolved_failures'
          : active > 0
            ? 'running'
            : idle
              ? 'idle_observation'
              : 'idle',
    incidents,
    noLongerLatest: (previous.incidents || [])
      .filter((i) => !incidents.some((n) => n.id === i.id))
      .map((i) => ({
        id: i.id,
        note: '原失败不再是最新待处理轮；须核对后续实际进展，不能据此声称原数据通过',
      })),
  };
}
