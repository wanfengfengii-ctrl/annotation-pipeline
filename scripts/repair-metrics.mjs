import fs from 'node:fs';
import path from 'node:path';
import { readJSON } from './self-heal-io.mjs';
export function repairMetrics(root, state, now = Date.now()) {
  const jobs = (state.jobs || []).map((row) => {
    const dir = path.join(root, '.runner/self-heal/jobs', row.id);
    const job = readJSON(path.join(dir, 'job.json'), row);
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n) => n.endsWith('.events.jsonl'))
      : [];
    let inputTokens = 0,
      outputTokens = 0,
      usageKnown = 0;
    for (const name of files) {
      const file = path.join(dir, name),
        size = fs.statSync(file).size;
      const buffer = Buffer.alloc(Math.min(size, 65536)),
        fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      } finally {
        fs.closeSync(fd);
      }
      let usage;
      for (const line of buffer.toString('utf8').split('\n')) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'turn.completed' && e.usage) usage = e.usage;
        } catch {}
      }
      if (
        Number.isFinite(usage?.input_tokens) &&
        Number.isFinite(usage?.output_tokens)
      ) {
        usageKnown++;
        inputTokens += usage.input_tokens;
        outputTokens += usage.output_tokens;
      }
    }
    const incident = state.incidents?.[row.incidentId];
    const restored =
      incident?.state === 'resolved' &&
      ['published', 'retried'].includes(job.state);
    return {
      id: job.id,
      taskId: incident?.taskId,
      mode: job.mode || 'repair',
      state: job.state,
      phase: job.phase,
      startedAt: job.startedAt,
      elapsedMs: Math.max(
        0,
        (job.state === 'running'
          ? now
          : Date.parse(job.updatedAt || job.startedAt)) -
          Date.parse(job.startedAt),
      ),
      modelInvocations: files.length,
      usageKnown,
      inputTokens: usageKnown ? inputTokens : null,
      outputTokens: usageKnown ? outputTokens : null,
      restored,
      effect: restored
        ? '已核对生产恢复'
        : ['published', 'retried'].includes(job.state)
          ? '已执行，等待实际恢复'
          : job.state === 'running'
            ? '处理中'
            : '本次未完成恢复',
    };
  });
  const recent = jobs.filter(
    (j) =>
      now - Date.parse(j.startedAt) >= 0 &&
      now - Date.parse(j.startedAt) < 86400000,
  );
  const fixed = Object.values(state.incidents || {}).flatMap((i) =>
    (i.fixedRecoveries || []).map((r) => ({
      ...r,
      resolved: i.state === 'resolved',
    })),
  );
  return {
    windowHours: 24,
    jobs: jobs.slice(-20),
    attempts: recent.length,
    modelInvocations: recent.reduce((n, j) => n + j.modelInvocations, 0),
    usageKnown: recent.reduce((n, j) => n + j.usageKnown, 0),
    inputTokens: recent.some((j) => j.usageKnown)
      ? recent.reduce((n, j) => n + (j.inputTokens || 0), 0)
      : null,
    outputTokens: recent.some((j) => j.usageKnown)
      ? recent.reduce((n, j) => n + (j.outputTokens || 0), 0)
      : null,
    restored: recent.filter((j) => j.restored).length,
    fixedActions24h: fixed.filter((r) => now - Date.parse(r.at) < 86400000)
      .length,
    fixedRestored24h: fixed.filter(
      (r) =>
        now - Date.parse(r.at) < 86400000 && r.resolved && r.state === 'queued',
    ).length,
    note: '调用次数按修复阶段启动记录统计；仅累计实际返回的 token 用量，不估算费用。发布或排队不计为恢复。',
  };
}
