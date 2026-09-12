export const operationsVersion = '2026-09-12.operations1';
const short = (value) =>
  String(value || '')
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]{12,}/g, '[凭据已隐藏]')
    .slice(0, 360);
export function operationsSnapshot({
  tasks,
  state,
  metrics,
  throughput,
  config,
  boundary,
  currentRevision,
  now = Date.now(),
}) {
  const rows = tasks
    .filter(
      (t) =>
        (t.projectSeries && !t.closed) ||
        t.turns.some((r) => r.status === 'running'),
    )
    .map((task) => {
      const turn =
        task.turns.find((r) => r.status === 'running') || task.turns.at(-1);
      const key = task.id + ':' + turn?.id;
      const issue = state.health?.incidents?.find((i) => i.id === key);
      const incidents = Object.values(state.incidents || {}).filter(
        (i) =>
          i.taskId === task.id &&
          i.turnId === turn?.id &&
          i.observedAt === state.checkedAt &&
          i.state !== 'resolved',
      );
      const incident =
        incidents.find((i) => i.jobId === state.activeJob) ||
        incidents.find((i) => i.state === 'needs_input') ||
        incidents[0];
      const progress = state.health?.progress?.[key];
      let status = 'idle',
        next = '等待调度确认下一步',
        owner = '执行器';
      if (incident?.jobId && incident.jobId === state.activeJob) {
        status = 'repairing';
        next = '诊断后进行复核与测试，再核对实际恢复';
        owner = '自愈修复';
      } else if (incident?.state === 'needs_input') {
        status = 'waiting_input';
        next = '处理所列阻碍后重新核验恢复条件';
        owner = '需要人工处理';
      } else if (issue?.state === 'stalled_running') {
        status = 'stalled';
        next = '读取原始进展和当前步骤，确认停滞原因';
        owner = '自愈队列';
      } else if (turn?.status === 'running') {
        status =
          turn.stage === 'claude' &&
          (!progress?.lastProgressKind ||
            progress.lastProgressKind === 'user') &&
          !progress?.pendingTools
            ? 'waiting_model'
            : 'processing';
        next =
          status === 'waiting_model'
            ? '等待当前会话返回，保留已发送输入'
            : '继续当前阶段，完成后进入下一步';
      } else if (issue?.stage === 'finalization') {
        status = 'archiving';
        next = '核验原终端导出和最终回执';
      } else if (issue?.state === 'open') {
        status = 'repair_queued';
        next = state.activeJob
          ? '等待当前修复完成后接手'
          : '按恢复条件执行或诊断';
        owner = '自愈队列';
      } else if (turn?.status === 'queued') {
        status = 'queued';
        next = '有可用槽位后领取，沿用现有检查点';
      }
      return {
        taskId: task.id,
        projectName: short(task.projectName),
        title: short(task.title.split('：')[0]),
        turnId: turn?.id,
        stage: turn?.stage || '',
        status,
        owner,
        next,
        lastProgressAt: progress?.lastProgressAt || null,
        reason: short(
          [
            'waiting_input',
            'repairing',
            'stalled',
            'repair_queued',
            'archiving',
          ].includes(status)
            ? incident?.result || issue?.reason || incident?.reason
            : '',
        ),
        lastDeliveryAt:
          task.turns
            .filter((r) => r.automation?.delivery?.value?.passed)
            .map((r) => r.automation.delivery.finishedAt || r.finishedAt)
            .filter(Boolean)
            .sort()
            .at(-1) || null,
      };
    });
  return {
    version: operationsVersion,
    checkedAt: state.checkedAt,
    reportedAt: new Date(now).toISOString(),
    guardian: {
      enabled: config.enabled === true,
      repairEnabled: config.repairEnabled === true,
      activeJob: state.activeJob || null,
      intervalMs: config.intervalMs,
      unlimited: config.maxRepairsPerDay == null,
    },
    projects: rows,
    metrics,
    throughput: throughput
      ? {
          observedAt: throughput.observedAt,
          counts: throughput.counts,
          flow: throughput.flow || null,
        }
      : null,
    release: {
      target: currentRevision || null,
      finalization: boundary?.finalization || null,
      supply: boundary?.supply || null,
      boundaryCheckedAt: boundary?.checkedAt || null,
    },
  };
}
export function validateOperations(value) {
  if (
    value?.version !== operationsVersion ||
    !Number.isFinite(Date.parse(value.checkedAt)) ||
    !Array.isArray(value.projects) ||
    value.projects.length > 500 ||
    JSON.stringify(value).length > 512000
  )
    throw Error('运行状态报告格式无效');
  for (const p of value.projects) {
    if (
      typeof p.taskId !== 'string' ||
      typeof p.status !== 'string' ||
      typeof p.next !== 'string'
    )
      throw Error('项目运行状态缺少必要字段');
  }
  return value;
}
