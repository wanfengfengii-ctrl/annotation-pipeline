import {
  supplyFailure,
  supplyCredentialsRevision,
  wordingRepairAllowed,
} from './supply-recovery.mjs';
import { PilotGate } from './pilot-gate.mjs';
import { saveThroughputReport } from './throughput-report.mjs';
import * as defaultExecutor from './job-executor.mjs';
import { loadJobRelease } from './job-release.mjs';
import { ProviderHealth } from './provider-health.mjs';
import { StageBudget } from './stage-budget.mjs';
import { FinalizationQueue } from './finalization-queue.mjs';
import { checkpointVersion } from './stage-checkpoint.mjs';

import { createRunnerApi } from './runner-api.mjs';

import { seriesVersion } from '../lib/project-series.mjs';
import { workflow } from '../lib/workflow.mjs';

import { questionRules } from '../lib/question-writing.mjs';

import { DockerRuntime } from './docker-runtime.mjs';

import {
  containerCapacity,
  resourceProfile,
} from '../lib/container-policy.mjs';

import {
  queueFinalSubmission,
  flushFinalSubmissions,
} from './final-submissions.mjs';
import { acquireLock, livingChildren, recoveryFiles } from './recovery.mjs';
import {
  rules,
  policyInstructions,
  candidateDigest,
  assertPolicyAudit,
} from '../lib/task-policy.mjs';
import { githubStatus } from './github-snapshot.mjs';
import { InitialCodePublisher } from './initial-code-snapshot.mjs';
import {
  resources,
  fingerprint,
  supplyDecision,
  createLoadAdmission,
  readConcurrencyMode,
  canReplenish,
  heavyMemoryBudget,
  projectCapacityWithVerifier,
} from './scheduler.mjs';
import { codexStage as runCodexStage } from './codex-stages.mjs';

import { runtimeVersion } from '../lib/runtime-verification.mjs';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token =
  process.env.RUNNER_TOKEN ||
  readFileSync(path.join(root, '.dev.vars'), 'utf8').match(
    /^RUNNER_TOKEN=(.+)$/m,
  )?.[1];
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
function submissionSecrets(jobToken) {
  let configured = {};
  try {
    configured =
      JSON.parse(
        readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'),
      ).env || {};
  } catch {}
  return [
    token,
    jobToken,
    process.env.apikey,
    configured.ANTHROPIC_AUTH_TOKEN,
    configured.ANTHROPIC_API_KEY,
  ].filter((value) => typeof value === 'string' && value.length >= 12);
}
const workRoot = path.resolve(
  process.env.RUNNER_WORK_ROOT || path.join(root, '.runner'),
);
mkdirSync(workRoot, { recursive: true });
// Persist this runner's selected resource budget across monitor restarts.
// The isolated work root keeps fixtures and other installations independent.
const profilePath = path.join(workRoot, 'resource-profile.json');
if (!process.env.RUNNER_RESOURCE_PROFILE && existsSync(profilePath)) {
  const saved = JSON.parse(readFileSync(profilePath, 'utf8'));
  if (!['standard', 'lightweight'].includes(saved.profile))
    throw Error('保存的执行器资源预算无效');
  process.env.RUNNER_RESOURCE_PROFILE = saved.profile;
}
resourceProfile();
const lock = path.join(workRoot, 'runner.lock');
acquireLock(lock);
let stopping = false;
const budget = new StageBudget({ stopped: () => stopping });
let draining = false;
const loadAdmission = createLoadAdmission();
// Graceful upgrades stop admissions, but finish existing stages and Terminal work.
process.on('SIGUSR2', () => {
  draining = true;
});
const children = new Set();
function track(p) {
  if (!p) return;
  children.add(p);
  p.once('close', () => children.delete(p));
  if (stopping) p.kill('SIGTERM');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    budget?.pump();
    for (const p of children) p.kill('SIGTERM');
    const hard = setTimeout(() => {
      for (const p of children) p.kill('SIGKILL');
    }, 10000);
    hard.unref();
  });
process.on('exit', () => {
  try {
    unlinkSync(lock);
  } catch {}
});
const command = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim();
const version = 'Claude Code · Mac Terminal 交互作业';
const initialCodePublisher = new InitialCodePublisher();
const codexVersion = command('codex', ['--version'], root);
let github = githubStatus(),
  githubChecked = Date.now();
const api = createRunnerApi({ base, token });
let schedulerStatus = {};
let throughput = null,
  metricsCheckedAt = 0;
const beat = () =>
  api({
    action: 'heartbeat',
    version,
    codexVersion,
    scheduler: schedulerStatus,
    github,
  });
const heartbeat = setInterval(() => beat().catch(() => {}), 10000);
const containers = new DockerRuntime(
  workRoot,
  (container) =>
    api({ action: 'container', taskId: container.taskId, container }),
  () => stopping,
  undefined,
  undefined,
  (state) => queueFinalSubmission(workRoot, state),
);

const providerHealth = new ProviderHealth({
  file: path.join(workRoot, 'provider-health.json'),
});
const pilot = new PilotGate(workRoot);
const execute = async (job) => {
  const selected = await loadJobRelease(workRoot, {
    root,
    module: defaultExecutor,
  });
  const jobContainers =
    selected.root === root
      ? containers
      : selected.module.createJobRuntime(
          workRoot,
          (container) =>
            api({ action: 'container', taskId: container.taskId, container }),
          () => stopping,
          undefined,
          undefined,
          (state) => queueFinalSubmission(workRoot, state),
        );
  const executeJob = selected.module.createJobExecutor({
    root: selected.root,
    api,
    containers: jobContainers,
    workRoot,
    track,
    isStopping: () => stopping,
    initialCodePublisher,
    budget,
    release: selected.commit || selected.root,
  });
  try {
    return await executeJob(job);
  } finally {
    if (jobContainers !== containers) jobContainers.detach();
  }
};
const finalizations = new FinalizationQueue({
  runtime: containers,
  refresh: async () =>
    (await api({ action: 'supply-context' })).containerTasks || [],
  onError: (error) => console.error('会话归档待重试：' + error.reason),
  onComplete: (taskId, state) => pilot.finalized(taskId, state),
});
async function deliver(result, receipt) {
  await api(result);
  writeFileSync(
    receipt + '.delivered',
    createHash('sha256').update(readFileSync(receipt)).digest('hex'),
  );
}
console.log(
  `Codex 编排 / Claude 执行器就绪 · ${version} · ${base} · 使用 CLI 配置模型`,
);
try {
  for (const receipt of recoveryFiles(workRoot, 'result')) {
    if (
      !existsSync(receipt + '.delivered') ||
      readFileSync(receipt + '.delivered', 'utf8') !==
        createHash('sha256').update(readFileSync(receipt)).digest('hex')
    )
      await deliver(JSON.parse(readFileSync(receipt, 'utf8')), receipt);
  }
  const orphans = [];
  for (const journal of recoveryFiles(workRoot, 'job'))
    if (!existsSync(journal + '.done')) orphans.push(journal);
  async function recoverOrphans() {
    // Iterate a snapshot because completed journals are removed from the live list.
    for (const journal of orphans.slice()) {
      const j = JSON.parse(readFileSync(journal, 'utf8'));
      const live = livingChildren(j).length > 0;
      const cachePath = journal.replace('.job.json', '.stages.json');
      const cache = existsSync(cachePath)
        ? JSON.parse(readFileSync(cachePath, 'utf8'))
        : {};
      const r = await api({
        action: 'recover',
        ...j,
        live,
        salvage: cache.claude || null,
      });
      if (!live || r.done) {
        writeFileSync(journal + '.done', '1');
        orphans.splice(orphans.indexOf(journal), 1);
      }
    }
  }
  await recoverOrphans();
  const active = new Map();
  const supplyDir = path.join(workRoot, 'supply');
  mkdirSync(supplyDir, { recursive: true });
  const statePath = path.join(supplyDir, 'state.json');
  const supplyState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : {};
  let generating = null;
  const saveSupply = () =>
    writeFileSync(statePath, JSON.stringify(supplyState), { mode: 0o600 });
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runJob(job) {
    console.log(`开始：${job.task.title} / ${job.turn.id}`);
    const jobDir = path.join(workRoot, job.task.id);
    mkdirSync(jobDir, { recursive: true });
    const journal = path.join(jobDir, job.turn.id + '.job.json');
    writeFileSync(
      journal,
      JSON.stringify({
        taskId: job.task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        children: [],
      }),
      { mode: 0o600 },
    );
    let outcome;
    try {
      outcome = await execute(job);
    } catch (e) {
      const result = {
        action: 'finish',
        taskId: job.task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        success: false,
        error: '执行器异常：' + e.message,
      };
      const receipt = path.join(jobDir, job.turn.id + '.result.json');
      writeFileSync(receipt, JSON.stringify(result), { mode: 0o600 });
      outcome = { result, receipt };
    }
    const { result, receipt } = outcome;
    providerHealth.observe(job.task.id, result);
    providerHealth.release(job.task.id);
    do {
      try {
        await deliver(result, receipt);
        writeFileSync(journal + '.done', '1');
        break;
      } catch (e) {
        console.error('回写失败，将重试：' + e.message);
        if (stopping) break;
        await nap(5000);
      }
    } while (!stopping);
    console.log(
      result.success
        ? '该轮已完成 Codex 评分与交付校验'
        : '该轮异常：' + result.error,
    );
  }
  async function replenish(context) {
    const codexStage = (options) =>
      budget.run('codex', 'supply', options.stage, () =>
        runCodexStage(options),
      );
    try {
      // Reuse an undelivered generation across a network failure or restart.
      let payload = supplyState.pending;
      if (!payload) {
        let draft = supplyState.draft;
        if (!draft) {
          const index = (supplyState.cursor || 0) % context.repos.length;
          const repoPath = context.repos[index];
          const projectSeries = {
            version: seriesVersion,
            directory: 'projects/p-' + randomUUID(),
          };
          const history = context.history.slice(0, 200);
          draft = {
            repoPath,
            projectSeries,
            history,
            requestId: randomUUID(),
            prompt: `Codex 负责先生成通用项目骨架，再设计该项目首个全新功能，Claude 在可见终端中实现该功能。首题 category 必须为 0-1 代码生成。只读分析当前仓库，仅将其作为出题参考，Claude 在新容器 /workspace 中已准备好的最小骨架上工作，容器不可访问参考仓库。在相对目录 ${projectSeries.directory} 的项目骨架内设计此前不存在的全新功能，不修改该目录外业务。完整首题描述能运行的全新功能及用户操作，正文不包含浏览器验收或编排步骤，后续在同项目继续出全新功能、Feature 迭代、真实 Bug 修复、理解和重构题，目标比例 7:7:10:1:1；0-1 与 Feature 各最多十题。出题范围：${context.config.scope}\n今日已完成及排队题型分布：${JSON.stringify(context.mix)}。新项目首题始终为 0-1；类型分布在同项目的后续题中调节。\n${policyInstructions()}\n不要重复或改写已有题目：${JSON.stringify(history)}\n禁止依赖其他自动任务的改动。不要提出需要外部付费、发布、推送或外部消息的任务。不执行此任务，只返回具体任务目标和验收要求。title 使用简洁项目名称，最多 200 字；prompt 从项目名称开始，不加编号，正文按内容自然分段，按真实需求决定篇幅；stack 最多 300 字，只记录适合业务的建议，不把实现偏好强加为题目限制。`,
          };
          supplyState.cursor = index + 1;
          supplyState.draft = draft;
          saveSupply();
        }
        const { repoPath, projectSeries } = draft;
        const history = context.history.slice(0, 200);
        if (!draft.generated) {
          draft.generated = await codexStage({
            stage: 'generate',
            cwd: repoPath,
            dir: supplyDir,
            turnId: draft.requestId,
            onChild: track,
            prompt: draft.prompt,
          });
          saveSupply();
        }
        const generated = draft.generated;
        const rejectDraft = (message) => {
          supplyState.rejectedDrafts = [
            ...(supplyState.rejectedDrafts || []),
            { ...draft, reason: message },
          ].slice(-20);
          delete supplyState.draft;
          saveSupply();
          throw Error(message);
        };
        if (generated.value.category !== '0-1 代码生成')
          rejectDraft('自动新项目首题必须是 0-1 代码生成');
        if (existsSync(path.join(repoPath, projectSeries.directory)))
          rejectDraft('新项目目标目录已存在');
        if (
          history.some(
            (t) =>
              fingerprint(repoPath, t.title) ===
              fingerprint(repoPath, generated.value.title),
          )
        )
          rejectDraft('Codex 生成了重复标题');
        if (draft.wordingRepair && !draft.wordingRepair.result) {
          draft.wordingRepair.result = await codexStage({
            stage: 'generate',
            cwd: repoPath,
            dir: supplyDir,
            turnId: draft.requestId + '.wording',
            onChild: track,
            generationWordingBase: generated.value,
            prompt:
              '仅修订下列题目的口语表达和格式，保留原业务对象、主要功能和验收范围，不能削弱难度或换题。只返回 prompt，其他字段由系统冻结。\n' +
              JSON.stringify({
                original: generated.value,
                feedback: draft.wordingRepair.feedback,
              }),
          });
          saveSupply();
        }
        const candidate = draft.wordingRepair?.result || generated;
        payload = {
          action: 'enqueue-auto',
          projectSeries,
          repoPath,
          ...candidate.value,
          tracePath: candidate.tracePath,
          fingerprint: fingerprint(repoPath, candidate.value.prompt),
        };
        const auditPrompt = `${policyInstructions()}\n这是首轮自动新任务，没有后续简单修复例外。独立审核候选题：${JSON.stringify(candidate.value)}\n全仓库最近历史：${JSON.stringify(history)}\n逐类检查并在 checkedGroups 返回所有组 ID。只有核心功能不落入禁出范围、无实质雷同且难度合格时 allowed=true。matchedRuleIds 和 duplicateTaskIds 必须与结论一致；reason 给出依据。${draft.wordingRepair ? '\n此外核对修订前后的主要业务目标、功能和验收范围未减少：' + JSON.stringify(generated.value) : ''}`;
        const audit = await codexStage({
          stage: 'policy',
          cwd: repoPath,
          dir: supplyDir,
          turnId: draft.requestId + (draft.wordingRepair ? '.repaired' : ''),
          onChild: track,
          prompt: auditPrompt,
        });
        audit.proposedDifficulty = payload.difficulty;
        payload.difficulty = audit.value.assessedDifficulty;
        audit.ruleVersion = rules.version;
        audit.questionRuleVersion = questionRules.version;
        audit.candidateDigest = await candidateDigest(payload);
        supplyState.lastAudit = audit;
        try {
          assertPolicyAudit(audit, audit.candidateDigest, {
            requireQuestionStyle: true,
          });
        } catch (error) {
          if (wordingRepairAllowed(audit, draft)) {
            draft.wordingRepair = { feedback: audit.value.reason };
            saveSupply();
            return replenish(context);
          }
          rejectDraft(error.message);
        }
        payload.policyAudit = audit;
        supplyState.pending = payload;
        saveSupply();
      }
      if (stopping) return;
      if (
        payload.policyAudit?.ruleVersion !== rules.version ||
        payload.policyAudit?.questionRuleVersion !== questionRules.version ||
        payload.projectSeries?.version !== seriesVersion
      ) {
        delete supplyState.pending;
        delete supplyState.draft;
        saveSupply();
        throw Error('出题规则已更新，将重新生成并审核');
      }
      const res = await api(payload);
      delete supplyState.pending;
      delete supplyState.draft;
      delete supplyState.failure;
      delete supplyState.authPause;
      supplyState.failures = 0;
      supplyState.lastError = '';
      supplyState.nextAt = Date.now() + 60000;
      supplyState.lastResult =
        res.skipped ||
        (res.duplicate ? '重复任务已跳过' : '已自动补充一个任务');
      saveSupply();
    } catch (e) {
      supplyFailure(supplyState, e);
      saveSupply();
      console.error('自动补充失败：' + e.message);
    }
  }
  while (!stopping) {
    try {
      if (orphans.length) await recoverOrphans();
      const context = await api({ action: 'supply-context' });
      if (
        supplyState.authPause &&
        supplyState.authPause.credentialsRevision !==
          supplyCredentialsRevision()
      ) {
        delete supplyState.authPause;
        supplyState.nextAt = 0;
        saveSupply();
      }
      if (Date.now() - metricsCheckedAt > 60000) {
        try {
          throughput = await saveThroughputReport({ base, workRoot });
        } catch (error) {
          console.error(error.message);
        }
        metricsCheckedAt = Date.now();
      }
      if (Date.now() - githubChecked > 300000) {
        github = githubStatus();
        githubChecked = Date.now();
      }
      providerHealth.reconcile(context.runningTaskIds);
      finalizations.enqueue(
        context.containerTasks || [],
        new Set(active.keys()),
      );
      await flushFinalSubmissions({
        workRoot,
        api,
        knownSecrets: submissionSecrets,
        onError: (error) => console.error(error.reason),
      });
      const profile = resourceProfile();
      const occupied = active.size + orphans.length + Number(!!generating);
      const resource = resources(
        pilot.capacity(Math.min(3, context.config.concurrency)),
        {
          profile,
          occupied,
          loadAdmission,
          concurrencyMode: readConcurrencyMode(workRoot),
        },
      );
      const docker = containers.resourceStatus();
      const hostCapacity = resource.effective;
      resource.effective = containerCapacity(
        docker,
        Math.min(
          resource.effective,
          Math.max(occupied, projectCapacityWithVerifier(docker, profile)),
        ),
        {
          profile,
          occupied,
        },
      );
      resource.recommended = containerCapacity(docker, resource.recommended, {
        profile,
        occupied,
      });
      resource.reason = !docker.ready
        ? docker.reason
        : resource.effective === 0
          ? hostCapacity === 0
            ? '宿主机可用内存不足，暂停领取新任务'
            : 'Docker 资源不足，暂停领取新任务'
          : hostCapacity < context.config.concurrency
            ? resource.reason
            : docker.resourceSample?.reason ||
              '同时按宿主机与 Docker 虚拟机资源限制';
      const readySources = docker.ready ? context.repos : [];
      const heavyMemoryPoolBytes = heavyMemoryBudget(
        docker,
        profile,
        6 * 2 ** 30,
      );
      budget.update(resource.effective, {
        heavyAllowed: heavyMemoryPoolBytes > 0,
        heavyMemoryPoolBytes,
      });
      schedulerStatus = {
        ...resource,
        stages: budget.snapshot(),
        throughput,
        finalizing: finalizations.active.size,
        providerHealth: providerHealth.snapshot(),
        pilot: pilot.read(),
        draining,
        checkpointVersion,
        resourceProfile: profile,
        active: active.size,
        recovering: orphans.length,
        generating: !!generating,
        configured: context.config.concurrency,
        enabled: context.config.enabled,
        generatedToday: context.generatedToday,
        queuedCandidates: context.queuedCount || 0,
        candidateBuffer: context.candidateBuffer || 1,
        dailyLimit: context.config.dailyLimit,
        repoCount: context.repos.length,
        workflowVersion: workflow.version,
        runtimeVerificationVersion: runtimeVersion,
        docker,
        residentContainers: containers.residents().length,
        mix: context.mix,
        ruleVersion: rules.version,
        lastAudit: supplyState.lastAudit
          ? {
              allowed: supplyState.lastAudit.accepted === true,
              reason:
                supplyState.lastAudit.rejection ||
                supplyState.lastAudit.value.reason,
            }
          : null,
        supply: generating
          ? 'Codex 正在生成任务'
          : resource.effective === 0
            ? resource.reason
            : (context.repos.length && !readySources.length
                ? docker.reason
                : null) ||
              supplyDecision(context, supplyState) ||
              supplyState.lastResult ||
              '等待补充',
        supplyFailure: supplyState.failure || null,
        draftPending: !!supplyState.draft,
        nextAt: supplyState.nextAt || null,
      };
      await beat();
      if (
        draining &&
        active.size === 0 &&
        orphans.length === 0 &&
        !generating &&
        !finalizations.active.size
      )
        break;
      // Claims are sequential; executions are independent. Generation consumes one slot too.
      while (
        !stopping &&
        !draining &&
        providerHealth.canAdmit() &&
        active.size + orphans.length + Number(!!generating) < resource.effective
      ) {
        const residents = containers.residents();
        const reservedResidents =
          residents.length +
          [...active.keys()].filter((id) => !residents.includes(id)).length;
        const residentCapacity = containerCapacity(
          docker,
          Math.min(3, projectCapacityWithVerifier(docker, profile)),
          {
            profile,
            occupied: residents.length,
          },
        );
        const { job } = await api({
          action: 'claim',
          recoveryRevision: (
            await loadJobRelease(workRoot, { root, module: defaultExecutor })
          ).commit,
          excludeTaskIds: [...finalizations.active.keys()],
          residentTaskIds: residents,
          allowNewContainer: reservedResidents < residentCapacity,
          capacity: resource.effective - Number(!!generating) - orphans.length,
        });
        if (!job) break;
        providerHealth.admit(job.task.id);
        pilot.admit(job.task.id, job.turn.questionRootId || job.turn.id);
        const promise = runJob(job)
          .catch((e) => console.error(e.message))
          .finally(() => active.delete(job.task.id));
        active.set(job.task.id, promise);
      }
      if (
        !stopping &&
        !draining &&
        canReplenish(context, supplyState, {
          capacity: resource.effective,
          active: active.size,
          recovering: orphans.length,
          generating: !!generating,
          readySources,
          stageAvailable:
            budget.running.size < resource.effective && !budget.waiting.length,
        })
      ) {
        generating = replenish({ ...context, repos: readySources }).finally(
          () => {
            generating = null;
          },
        );
      }
      await nap(2500);
    } catch (e) {
      console.error(e.message);
      await nap(5000);
    }
  }
  await Promise.allSettled([
    ...active.values(),
    ...finalizations.active.values(),
    ...(generating ? [generating] : []),
  ]);
} finally {
  clearInterval(heartbeat);
  containers.detach();
}
