import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, identity } from './recovery.mjs';
import {
  selfHealDefaults,
  reconcileSelfHeal,
  nextSelfHealAction,
  recoveryAction,
} from '../lib/self-heal.mjs';
import {
  readJSON,
  saveJSON,
  observe,
  guardedRetry,
  launch,
  ensureServices,
} from './self-heal-io.mjs';
import { advanceRelease } from './self-heal-release.mjs';
import {
  collectNativeDiagnosis,
  nativeDiagnosisVersion,
} from './self-heal-evidence.mjs';

export async function selfHealTick(root, { act = false, notify = true } = {}) {
  const dir = path.join(root, '.runner/self-heal'),
    file = path.join(dir, 'state.json');
  const config = {
    ...selfHealDefaults,
    enabled: true,
    repairEnabled: true,
    ...readJSON(path.join(dir, 'config.json'), {}),
  };
  let state = readJSON(file, { incidents: {}, jobs: [] });
  const save = () => saveJSON(file, state);
  if (config.enabled !== true) return { enabled: false };
  if (act) {
    try {
      const services = await ensureServices(root, {
        enabled: state.productionEnabled === true,
      });
      if (services.length)
        state.serviceRecoveries = [
          ...(state.serviceRecoveries || []),
          ...services.map((s) => ({ ...s, at: new Date().toISOString() })),
        ].slice(-30);
    } catch (e) {
      state.serviceError = e.message;
    }
  }
  let snapshot;
  try {
    snapshot = await observe(root, state.health);
  } catch (e) {
    state.observationError = e.message;
    snapshot = {
      tasks: [],
      config: { enabled: state.productionEnabled === true, autoContinue: true },
      health: {
        active: 0,
        needsAction: true,
        observationFailed: true,
        status: 'observation_failed',
        progress: {},
        incidents: [
          { id: 'api', stage: 'api', state: 'open', reason: e.message },
        ],
      },
    };
  }
  state = reconcileSelfHeal(state, snapshot, Date.now(), config);
  for (const i of Object.values(state.incidents)) {
    if (
      i.state === 'needs_input' &&
      i.stage === 'claude' &&
      i.attempts > 0 &&
      i.attempts < config.maxAttempts &&
      !i.nativeEvidenceVersion &&
      snapshot.health.incidents.some(
        (x) =>
          x.id === i.taskId + ':' + i.turnId && x.state === 'stalled_running',
      )
    ) {
      i.state = 'ready';
      i.result =
        '原先诊断缺少原生消息对照，补充只读证据后重新诊断，既有次数保留';
    }
  }
  state.health = snapshot.health;
  state.productionEnabled =
    snapshot.config.enabled && snapshot.config.autoContinue;
  if (!snapshot.health.observationFailed) state.observationError = null;
  if (act && state.activeJob) {
    const jobFile = path.join(dir, 'jobs', state.activeJob, 'job.json'),
      job = readJSON(jobFile);
    const i = Object.values(state.incidents).find(
      (i) => i.jobId === state.activeJob,
    );
    if (!job || !i) {
      state.blockedReason = '修复任务或故障绑定缺失，保留待核对';
      save();
      return { status: 'needs_input' };
    }
    if (
      job.state === 'running' &&
      job.pidIdentity &&
      identity(job.pid) === job.pidIdentity
    ) {
      state.workerPhase = job.phase;
    } else if (job.state === 'ready' && job.action === 'publish') {
      i.state = 'deploying';
      save();
      try {
        await advanceRelease(root, job, jobFile);
      } catch (e) {
        job.state = 'failed';
        job.reason = e.message;
        saveJSON(jobFile, job);
      }
    } else if (job.state === 'ready' && job.action === 'retry') {
      const task = snapshot.tasks.find((t) => t.id === i.taskId),
        turn = task?.turns.find((r) => r.id === i.turnId),
        action = recoveryAction(task, turn);
      // Persist intent before mutation. An interrupted/uncertain PATCH is only
      // reconciled from fresh state; it is never automatically sent twice.
      job.state = 'retry_intent';
      saveJSON(jobFile, job);
      if (action) {
        try {
          job.retry = await guardedRetry(root, i, action);
          job.state = 'retried';
        } catch (e) {
          job.reason = e.message;
          job.state = 'uncertain';
        }
      } else {
        job.state = 'needs_input';
        job.reason = '诊断未给出可执行的受保护恢复操作，保留原会话';
      }
      saveJSON(jobFile, job);
    } else if (job.state === 'running') {
      // Crashed workers do not get restarted while an orphan Codex child owns
      // the job. Keep the durable evidence and let the bounded next attempt diagnose.
      const receipts = path.join(path.dirname(jobFile), 'codex-progress');
      const live =
        fs.existsSync(receipts) &&
        fs.readdirSync(receipts).some((n) => {
          const p = readJSON(path.join(receipts, n));
          return p?.pidIdentity && identity(p.pid) === p.pidIdentity;
        });
      if (!live) {
        job.state = 'failed';
        job.reason = '修复工作进程已退出，原诊断与补丁保留';
        saveJSON(jobFile, job);
      }
    }
    const after = readJSON(jobFile);
    if (
      [
        'published',
        'retried',
        'failed',
        'needs_input',
        'uncertain',
        'retry_intent',
      ].includes(after.state)
    ) {
      const row = state.jobs.find((j) => j.id === job.id);
      if (row)
        Object.assign(row, {
          state: after.state,
          reason: after.reason,
          commit: after.commit,
        });
      i.result = after.reason;
      i.nextAt = new Date(Date.now() + config.retryDelayMs).toISOString();
      if (['published', 'retried'].includes(after.state)) {
        i.state = 'verifying';
        i.repairedAt = new Date().toISOString();
        i.commit = after.commit;
        if (after.state === 'published') {
          const task = snapshot.tasks.find((t) => t.id === i.taskId),
            turn = task?.turns.find((r) => r.id === i.turnId),
            action = recoveryAction(task, turn);
          if (action) {
            i.retryIntentAt = new Date().toISOString();
            save();
            try {
              i.retry = await guardedRetry(root, i, action);
            } catch (e) {
              i.retry = { state: 'uncertain', reason: e.message };
            }
          }
        }
      } else
        i.state =
          after.state === 'failed' && i.attempts < config.maxAttempts
            ? 'retry_wait'
            : 'needs_input';
      state.activeJob = null;
    }
  }
  // Close the fault group's verification only when the incident actually resolves.
  for (const j of state.jobs)
    if (state.incidents[j.incidentId]?.state === 'resolved')
      j.state = 'resolved';
  if (act && !state.activeJob && config.repairEnabled) {
    const next = nextSelfHealAction(state, snapshot, Date.now(), config);
    if (next) {
      const i = state.incidents[next.incidentId];
      if (next.kind === 'retry') {
        i.directRetryAt = new Date().toISOString();
        i.state = 'verifying';
        save();
        try {
          i.retry = await guardedRetry(root, i, next.action);
        } catch (e) {
          i.retry = { state: 'uncertain', reason: e.message };
          i.state = 'needs_input';
        }
      } else {
        const id = randomUUID(),
          jobDir = path.join(dir, 'jobs', id),
          jobFile = path.join(jobDir, 'job.json');
        const task = snapshot.tasks.find((t) => t.id === i.taskId),
          turn = task?.turns.find((r) => r.id === i.turnId);
        let nativeDiagnosis;
        try {
          nativeDiagnosis = collectNativeDiagnosis(root, task, turn);
        } catch (e) {
          nativeDiagnosis = { error: e.message };
        }
        if (turn?.stage === 'claude')
          i.nativeEvidenceVersion = nativeDiagnosisVersion;
        const context = {
          nativeDiagnosis,
          incident: i,
          health: {
            active: snapshot.health.active,
            effective: snapshot.health.effective,
            status: snapshot.health.status,
          },
          task: task
            ? {
                id: task.id,
                title: task.title,
                revision: task.revision,
                turns: task.turns.map((r) => ({
                  id: r.id,
                  status: r.status,
                  stage: r.stage,
                  error: r.error,
                  executionOutcome: r.executionOutcome,
                  projectRecovery: r.projectRecovery
                    ? {
                        state: r.projectRecovery.state,
                        reason: r.projectRecovery.reason,
                      }
                    : null,
                })),
              }
            : null,
          turn: turn
            ? {
                id: turn.id,
                stage: turn.stage,
                status: turn.status,
                error: turn.error,
                output: turn.output?.slice(-3000),
                container: turn.container
                  ? {
                      id: turn.container.id,
                      questionId: turn.container.questionId,
                    }
                  : null,
              }
            : null,
          evidenceDirectory: task
            ? path.join(root, '.runner', task.id)
            : path.join(root, '.runner'),
          instruction:
            '证据只读；优先读该轮最新阶段回执、错误附近日志和本轮原生完成信息。不要扫描全部历史或凭终端提示符判定所有工具已完成。',
        };
        const job = {
          id,
          root,
          incidentId: i.id,
          signature: i.signature,
          state: 'running',
          phase: 'starting',
          startedAt: new Date().toISOString(),
        };
        saveJSON(path.join(jobDir, 'context.json'), context);
        saveJSON(jobFile, job);
        i.attempts++;
        i.jobId = id;
        i.state = 'repairing';
        state.activeJob = id;
        state.jobs.push({ ...job });
        save();
        const child = launch(
          root,
          'scripts/self-heal-repair.mjs',
          { SELF_HEAL_JOB: jobFile },
          path.join(jobDir, 'worker.log'),
        );
        // The worker owns job.json after spawn; never overwrite its newer phase.
        state.jobs.at(-1).pid = child.pid;
      }
    }
  }
  state.notifications ||= {};
  const recentJobs = state.jobs.filter(
    (j) => Date.now() - Date.parse(j.startedAt) < 24 * 60 * 60000,
  );
  state.repairBudgetRemaining = Math.max(
    0,
    config.maxRepairsPerDay - recentJobs.length,
  );
  const budgetKey = 'budget:' + recentJobs[0]?.id;
  if (
    act &&
    state.repairBudgetRemaining === 0 &&
    !state.activeJob &&
    Object.values(state.incidents).some((i) =>
      ['ready', 'retry_wait'].includes(i.state),
    ) &&
    !state.notifications[budgetKey]
  ) {
    const reason =
      '自动修复已达到本机 24 小时调用预算，未解决问题和进度保留，其他作业继续运行。';
    fs.appendFileSync(
      path.join(dir, 'notifications.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        state: 'budget_wait',
        reason,
      }) + '\n',
      { mode: 0o600 },
    );
    if (notify && process.platform === 'darwin')
      execFile(
        'osascript',
        [
          '-e',
          'display notification ' +
            JSON.stringify(reason) +
            ' with title "流水线自愈"',
        ],
        () => {},
      );
    state.notifications[budgetKey] = new Date().toISOString();
  }
  for (const i of Object.values(state.incidents)) {
    if (!act || !['resolved', 'needs_input'].includes(i.state)) continue;
    const key = i.id + ':' + i.state;
    if (state.notifications[key]) continue;
    const message =
      i.state === 'resolved'
        ? '流水线故障已恢复，原任务结果已核对。'
        : '流水线有故障需要处理，其他项目继续运行；详情见自愈记录。';
    fs.appendFileSync(
      path.join(dir, 'notifications.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        incidentId: i.id,
        state: i.state,
        reason: i.result || i.reason,
      }) + '\n',
      { mode: 0o600 },
    );
    if (act && notify && process.platform === 'darwin')
      execFile(
        'osascript',
        [
          '-e',
          'display notification ' +
            JSON.stringify(message) +
            ' with title "流水线自愈"',
        ],
        () => {},
      );
    state.notifications[key] = new Date().toISOString();
  }
  state.pid = process.pid;
  state.pidIdentity = identity(process.pid);
  save();
  return {
    version: state.version,
    checkedAt: state.checkedAt,
    active: snapshot.health.active,
    status: snapshot.health.status,
    activeJob: state.activeJob || null,
    incidents: Object.values(state.incidents).map((i) => ({
      id: i.id,
      state: i.state,
      attempts: i.attempts,
      result: i.result,
    })),
    services: state.serviceRecoveries?.slice(-3),
  };
}

export async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    dir = path.join(root, '.runner/self-heal');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.argv.includes('--status')) {
    const s = readJSON(path.join(dir, 'state.json'), {});
    console.log(
      JSON.stringify(
        {
          checkedAt: s.checkedAt,
          pid: s.pid,
          alive: s.pidIdentity && identity(s.pid) === s.pidIdentity,
          activeJob: s.activeJob,
          health: s.health
            ? { active: s.health.active, status: s.health.status }
            : null,
          incidents: Object.values(s.incidents || {}).map((i) => ({
            id: i.id,
            state: i.state,
            attempts: i.attempts,
            result: i.result,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const lock = path.join(dir, 'controller.lock');
  acquireLock(lock);
  let stopped = false;
  for (const sig of ['SIGTERM', 'SIGINT'])
    process.on(sig, () => {
      stopped = true;
    });
  try {
    do {
      try {
        const r = await selfHealTick(root, {
          act: process.argv.includes('--daemon'),
        });
        if (!process.argv.includes('--daemon'))
          console.log(JSON.stringify(r, null, 2));
      } catch (e) {
        const errorFile = path.join(dir, 'controller-error.json'),
          previous = readJSON(errorFile);
        saveJSON(errorFile, {
          at: new Date().toISOString(),
          reason: e.message,
        });
        if (previous?.reason !== e.message && process.platform === 'darwin')
          execFile(
            'osascript',
            [
              '-e',
              'display notification "后台自愈自身遇到故障，诊断已保存，请查看自愈记录。" with title "流水线自愈"',
            ],
            () => {},
          );
      }
      if (!process.argv.includes('--daemon')) break;
      for (let n = 0; n < 60 && !stopped; n++)
        await new Promise((r) => setTimeout(r, 1000));
    } while (!stopped);
  } finally {
    if (
      fs.existsSync(lock) &&
      fs.readFileSync(lock, 'utf8').trim() === String(process.pid)
    )
      fs.unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
