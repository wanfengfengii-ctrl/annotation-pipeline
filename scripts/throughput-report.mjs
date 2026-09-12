import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeTiming } from './attempt-timing.mjs';

const median = (values) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y),
    i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
export function throughputReport({
  tasks,
  workRoot,
  ledger = {},
  now = new Date().toISOString(),
}) {
  const groups = new Map(),
    counts = {
      scored: 0,
      finalized: 0,
      submitted: 0,
      qcPassed: 0,
      pendingFix: 0,
    };
  let attempts = 0,
    replanningAttempts = 0,
    missingTiming = 0;
  const records = [];
  for (const task of tasks)
    for (const turn of task.turns) {
      const timings = summarizeTiming(
        path.join(workRoot, task.id, turn.id + '.timing.jsonl'),
      );
      attempts += timings.length;
      if (!timings.length) missingTiming++;
      const upload = ledger.entries?.[task.id + ':' + turn.id];
      const scored = !!turn.review?.scores?.length,
        finalized = !!turn.automation?.submission?.finalization;
      const submitted =
        upload?.state === 'submitted' &&
        upload.receiptVerified === true &&
        !upload.deletedByUser;
      const qcPassed = submitted && upload.remoteStatus === 'QC_PASSED';
      counts.scored += Number(scored);
      counts.finalized += Number(finalized);
      counts.submitted += Number(submitted);
      counts.qcPassed += Number(qcPassed);
      counts.pendingFix += Number(
        submitted && upload.remoteStatus === 'PENDING_FIX',
      );
      const groupKey =
        (turn.category || task.category) +
        ' / ' +
        (turn.difficulty || task.difficulty);
      const group = groups.get(groupKey) || {
        group: groupKey,
        completedAttempts: 0,
        failedAttempts: 0,
        durations: [],
        stageDurations: {},
      };
      for (const timing of timings) {
        if (timing.outcome?.startsWith('project-replan-')) {
          replanningAttempts++;
          continue;
        }
        if (timing.outcome === 'completed') {
          group.completedAttempts++;
          group.durations.push(timing.elapsedMs);
        } else if (timing.outcome === 'failed') group.failedAttempts++;
        for (const stage of timing.stages) {
          (group.stageDurations[stage.stage] ||= []).push(stage.elapsedMs);
        }
      }
      groups.set(groupKey, group);
      records.push({
        taskId: task.id,
        turnId: turn.id,
        scored,
        finalized,
        submitted,
        qcPassed,
        attempts: timings,
        productionHistory: turn.productionHistory || null,
      });
    }
  return {
    version: '2026-09-10.throughput1',
    observedAt: now,
    counts,
    attempts,
    replanningAttempts,
    missingTiming,
    note: '累计状态与每次尝试分开统计；历史缺少阶段计时不推算耗时，样本不足不宣称产量提升。',
    groups: [...groups.values()].map(({ durations, stageDurations, ...g }) => ({
      ...g,
      medianElapsedMs: median(durations),
      stages: Object.fromEntries(
        Object.entries(stageDurations).map(([name, values]) => [
          name,
          { samples: values.length, medianMs: median(values) },
        ]),
      ),
    })),
    records,
    flow: {
      firstDeliveries24h: records.reduce(
        (n, r) =>
          n +
          (r.productionHistory?.events || []).filter(
            (e) =>
              e.kind === 'first-delivery' &&
              Date.parse(now) - Date.parse(e.at) >= 0 &&
              Date.parse(now) - Date.parse(e.at) < 86400000,
          ).length,
        0,
      ),
      revalidations24h: records.reduce(
        (n, r) =>
          n +
          (r.productionHistory?.events || []).filter(
            (e) =>
              e.kind === 'revalidation' &&
              Date.parse(now) - Date.parse(e.at) >= 0 &&
              Date.parse(now) - Date.parse(e.at) < 86400000,
          ).length,
        0,
      ),
      historicalWithoutTimeline: records.filter(
        (r) => r.scored && !r.productionHistory,
      ).length,
      note: '新增和返修按实际交付事件统计；旧记录缺少首次交付历史时不推算为新产出。',
    },
  };
}

export async function saveThroughputReport({ base, workRoot }) {
  let response = await fetch(base + '/api/operations/source', {
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404)
    response = await fetch(base + '/api/tasks', {
      signal: AbortSignal.timeout(10000),
    });
  if (!response.ok) throw Error('读取产量指标失败');
  const tasks = (await response.json()).tasks;
  const ledgerPath = path.join(workRoot, 'solo-upload/ui-state.json');
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : {};
  const report = throughputReport({ tasks, workRoot, ledger });
  const dir = path.join(workRoot, 'throughput');
  mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(report, null, 2);
  writeFileSync(path.join(dir, 'latest.json'), data, { mode: 0o600 });
  const baseline = path.join(dir, 'baseline.json');
  if (!existsSync(baseline))
    writeFileSync(baseline, data, { mode: 0o600, flag: 'wx' });
  const start = JSON.parse(readFileSync(baseline, 'utf8'));
  const hours =
    (Date.parse(report.observedAt) - Date.parse(start.observedAt)) / 3600000;
  const summary = {
    observedAt: report.observedAt,
    counts: report.counts,
    flow: report.flow,
    attempts: report.attempts,
    missingTiming: report.missingTiming,
    observationHours: Math.max(0, hours),
    comparisonReady: hours >= 24,
    newQcPassed: report.records.filter(
      (r) =>
        r.qcPassed &&
        !start.records.some(
          (b) => b.taskId === r.taskId && b.turnId === r.turnId && b.qcPassed,
        ),
    ).length,
    groups: report.groups,
  };
  writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(summary, null, 2),
    { mode: 0o600 },
  );
  return summary;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(
    JSON.stringify(
      await saveThroughputReport({
        base: process.env.PIPELINE_API_URL || 'http://localhost:3000',
        workRoot: process.env.RUNNER_WORK_ROOT || path.join(root, '.runner'),
      }),
      null,
      2,
    ),
  );
}
