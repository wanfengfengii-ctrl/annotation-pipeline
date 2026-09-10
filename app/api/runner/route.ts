import { sessionFinalization } from '@/lib/session-finalization.mjs';
import { serializeTask } from '@/lib/task-storage.mjs';
import {
  gatewayFailureValid,
  gatewayContinuationVersion,
  planGatewayContinuation,
} from '@/lib/gateway-continuation.mjs';
import {
  validateSeries,
  claudeCallCount,
  shouldFinishSession,
  sessionLimits,
} from '@/lib/project-series.mjs';
import { validateContainerRecord } from '@/lib/container-policy.mjs';
import { questionRoot } from '@/lib/question-session.mjs';
import { terminalIssues } from '@/lib/terminal-policy.mjs';
import { permissionIssues } from '@/lib/permission-audit.mjs';
import { roundNumber } from '@/lib/record-metadata';
import {
  resolveInitialSnapshotContainer,
  validateInitialCodeSnapshot,
} from '@/lib/initial-code-snapshot.mjs';
import { nextDecision, dailyMix } from '@/lib/workflow.mjs';
import {
  disputeContinuationReady,
  blocksProject,
} from '@/lib/disputed-continuation.mjs';
import { candidateDigest, assertPolicyAudit } from '@/lib/task-policy.mjs';
import { questionIssues } from '@/lib/writing-style.mjs';
import { schedulerConfig } from '@/db/scheduler';
import { sources } from '@/lib/scheduler';
import {
  categories,
  difficulties,
  businessDate,
  type Task,
  type Turn,
} from '@/lib/pipeline';
import { all, get, save, db, failure, runnerAuth, text } from '@/db/store';

function submissionMetadata(input: unknown, task: Task, turn: Turn) {
  type Submission = NonNullable<NonNullable<Turn['automation']>['submission']>;
  const record = (item: unknown): Record<string, unknown> =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
  const value = record(input);
  const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const date = (v: unknown) =>
    typeof v === 'string' && Number.isFinite(Date.parse(v));
  if (
    JSON.stringify(value).length > 65000 ||
    typeof value.status !== 'string' ||
    !['passed', 'needs_review', 'awaiting_finalization', 'blocked'].includes(
      value.status,
    ) ||
    !sha(value.sourceArchiveSha256) ||
    !date(value.verifiedAt)
  )
    throw Error('提交包元数据无效');
  // These are runner receipts, never contents to merge into the scored record.
  const bounded = (item: unknown, key = '', depth = 0) => {
    if (depth > 16) throw Error('提交包元数据层级过深');
    if (
      (key === 'path' || key.endsWith('Path') || key.endsWith('Dir')) &&
      (typeof item !== 'string' ||
        !item.trim() ||
        item.length > 4000 ||
        item
          .split('')
          .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    )
      throw Error('提交包路径字段无效');
    if (item && typeof item === 'object')
      for (const [name, child] of Object.entries(item))
        bounded(child, name, depth + 1);
  };
  bounded(value);
  for (const [name, digest] of Object.entries(value))
    if ((name === 'sha256' || name.endsWith('Sha256')) && !sha(digest))
      throw Error('提交包摘要无效');
  for (const key of ['files', 'zipBytes'])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'number' ||
        !Number.isSafeInteger(value[key]) ||
        value[key] < 0)
    )
      throw Error('提交包计数字段无效');
  if (
    ['passed', 'needs_review'].includes(value.status) &&
    (!sha(value.manifestSha256) ||
      !sha(value.zipSha256) ||
      !value.manifestPath ||
      !value.zipArchivePath)
  )
    throw Error('提交包缺少可复核的清单或压缩包');
  if (!value.finalization) {
    if (!['awaiting_finalization', 'blocked'].includes(value.status))
      throw Error('提交包缺少最终完成回执');
    return value as Submission;
  }
  const finalization = record(value.finalization);
  const traceExport = record(finalization.traceExport);
  type TerminalFields = {
    terminal?: { runId?: string };
    terminalIdentity?: { runId?: string };
  };
  const container = turn.container as
    | (NonNullable<Turn['container']> & TerminalFields)
    | undefined;
  const terminalTurn = turn as Turn & TerminalFields;
  const questionId =
    turn.questionRootId || container?.questionId || questionRoot(task, turn);
  const runId =
    container?.terminal?.runId ||
    container?.terminalIdentity?.runId ||
    terminalTurn.terminal?.runId ||
    terminalTurn.terminalIdentity?.runId;
  // Old completed bridges exported this fixed directory before exportKind was
  // recorded. Register their unchanged receipt for review only, never delivery.
  const legacyFinalForReview =
    value.status === 'needs_review' &&
    finalization.commandTransport === 'legacy-runner-migration' &&
    traceExport.exportKind === undefined &&
    typeof traceExport.path === 'string' &&
    /\/final\.traces-\d+\/projects$/.test(traceExport.path) &&
    traceExport.manifestPath ===
      traceExport.path.replace(/\/projects$/, '/manifest.json');
  if (
    finalization.version !== '2026-09-10.terminal-finalization1' ||
    finalization.taskId !== task.id ||
    finalization.questionId !== questionId ||
    (container?.questionId && container.questionId !== questionId) ||
    !sha(container?.containerId) ||
    finalization.containerId !== container?.containerId ||
    !runId ||
    finalization.runId !== runId ||
    !turn.sessionId ||
    finalization.sessionId !== turn.sessionId ||
    finalization.status !== 'removed' ||
    typeof finalization.commandTransport !== 'string' ||
    !['original-mac-terminal', 'legacy-runner-migration'].includes(
      finalization.commandTransport,
    ) ||
    !sha(finalization.receiptSha256) ||
    !sha(finalization.manifestSha256) ||
    typeof finalization.receiptPath !== 'string' ||
    !finalization.receiptPath.endsWith(
      '/questions/' + questionId + '/terminal/finalization.json',
    ) ||
    !date(finalization.removedAt) ||
    traceExport.verified !== true ||
    (traceExport.exportKind !== 'final' && !legacyFinalForReview) ||
    typeof traceExport.path !== 'string' ||
    !traceExport.path.trim() ||
    traceExport.path.length > 4000 ||
    !traceExport.manifestPath ||
    typeof traceExport.files !== 'number' ||
    !Number.isSafeInteger(traceExport.files) ||
    traceExport.files < 0 ||
    !sha(traceExport.sha256) ||
    value.traceExportSha256 !== traceExport.sha256
  )
    throw Error('提交包最终回执与原题容器或终端不匹配');
  if (
    value.status === 'passed' &&
    finalization.commandTransport !== 'original-mac-terminal'
  )
    throw Error('旧终端迁移提交包必须保留人工复核状态');
  return value as Submission;
}

export async function POST(req: Request) {
  try {
    runnerAuth(req);
    const b: any = await req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error('请求格式无效');
    if (b.action === 'submission-package') {
      const item = await get(text(b.taskId, '任务 ID', 100));
      const turnId = text(b.turnId, '轮次 ID', 100);
      const turn = item?.task.turns.find((r) => r.id === turnId);
      if (
        !item ||
        !turn ||
        !['review', 'failed'].includes(turn.status) ||
        !Array.isArray(turn.review?.scores) ||
        turn.review.scores.length !== 5 ||
        turn.review.scores.some(
          (score) => !Number.isInteger(score) || score < 1 || score > 5,
        )
      )
        throw Error('仅允许回填已评分并归档的轮次');
      const source = text(b.sourceArchiveSha256, '原件归档摘要', 64);
      if (
        !/^[a-f0-9]{64}$/.test(source) ||
        source !== turn.automation?.archive?.sha256 ||
        b.submission?.sourceArchiveSha256 !== source
      )
        throw Error('提交包原件归档摘要不匹配');
      // The trusted runner verifies local bytes; this endpoint checks identity
      // and source bindings and only attaches the resulting receipt metadata.
      const submission = submissionMetadata(b.submission, item.task, turn);
      const existing = turn.automation?.submission;
      if (
        (submission.manifestSha256 &&
          existing?.manifestSha256 === submission.manifestSha256) ||
        JSON.stringify(existing) === JSON.stringify(submission)
      )
        return Response.json({ ok: true, duplicate: true });
      turn.automation!.submission = submission;
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    if (b.action === 'initial-code-snapshot') {
      const item = await get(text(b.taskId, '任务', 100));
      if (!item) throw Error('任务不存在');
      const root = item.task.turns.find((r) => r.id === b.questionId);
      if (!root || questionRoot(item.task, root) !== root.id)
        throw Error('初始快照必须属于实际原题容器');
      const container = resolveInitialSnapshotContainer(
        item.task.id,
        root.id,
        root.container,
        item.task.container,
      );
      const value = validateInitialCodeSnapshot(
        b.snapshot,
        item.task.id,
        root.id,
        container,
      );
      const existing = item.task.initialCodeSnapshots?.[root.id];
      if (
        existing &&
        (existing.sha !== value.sha ||
          existing.manifestSha256 !== value.manifestSha256)
      )
        throw Error('已冻结的 GitHub 初始快照不可替换');
      if (existing) return Response.json({ ok: true, url: existing.url });
      item.task.initialCodeSnapshots ||= {};
      item.task.initialCodeSnapshots[root.id] = value;
      await save(item.task, item.revision);
      return Response.json({ ok: true, url: value.url });
    }
    if (b.action === 'heartbeat') {
      await db()
        .prepare(
          'INSERT INTO runners(id,data,heartbeat) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,heartbeat=excluded.heartbeat',
        )
        .bind(
          'local',
          JSON.stringify({
            version: text(b.version, '版本', 200),
            mode: 'Codex 编排 / Claude 执行',
            github: b.github && typeof b.github === 'object' ? b.github : null,
            scheduler:
              b.scheduler && typeof b.scheduler === 'object'
                ? b.scheduler
                : null,
            codexVersion:
              typeof b.codexVersion === 'string' ? b.codexVersion : '',
          }),
          new Date().toISOString(),
        )
        .run();
      return Response.json({ ok: true });
    }
    if (b.action === 'supply-context') {
      const tasks = await all(),
        config = await schedulerConfig();
      return Response.json({
        config,
        mix: dailyMix(tasks, businessDate(new Date().toISOString())),
        repos: sources(config, tasks),
        containerTasks: tasks
          .filter((t) => t.container)
          .map((t) => ({
            id: t.id,
            containerStatus: t.container.status,
            closed: t.closed,
            finishContainer: shouldFinishSession(t),
            finalization: sessionFinalization(t),
          })),
        queuedCount: tasks.reduce(
          (count, t) =>
            count + t.turns.filter((r: Turn) => r.status === 'queued').length,
          0,
        ),
        candidateBuffer: 2,
        runningTaskIds: tasks
          .filter((t) =>
            t.turns.some(
              (r: Turn) => r.status === 'running' || r.recoveryBlocked,
            ),
          )
          .map((t) => t.id),
        queued: tasks.some((t) =>
          t.turns.some((r: any) => r.status === 'queued'),
        ),
        generatedToday: tasks.filter(
          (t) =>
            t.autoGenerated &&
            businessDate(t.createdAt) ===
              businessDate(new Date().toISOString()),
        ).length,
        history: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          prompt: t.turns
            .map((r: any) => r.requestedPrompt || r.prompt)
            .join('\n')
            .slice(0, 4000),
          repoPath: t.repoPath,
          autoGenerated: !!t.autoGenerated,
          failed: t.turns.some(blocksProject),
        })),
      });
    }
    if (b.action === 'enqueue-auto') {
      const tasks = await all(),
        config = await schedulerConfig();
      const fingerprint = text(b.fingerprint, '去重标识', 64);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('去重标识无效');
      const existing = tasks.find(
        (t) => t.autoGenerated?.fingerprint === fingerprint,
      );
      if (existing)
        return Response.json({ taskId: existing.id, duplicate: true });
      if (!config.enabled) return Response.json({ skipped: '自动补充已暂停' });
      if (!sources(config, tasks).includes(b.repoPath))
        throw Error('仓库不在自动补充范围内');
      if (
        !categories.includes(b.category) ||
        !difficulties.includes(b.difficulty) ||
        b.difficulty === '简单'
      )
        throw Error('自动题型或难度无效');
      validateSeries(b.projectSeries);
      if (b.category !== '0-1 代码生成')
        throw Error('自动新项目首题必须为 0-1 代码生成');
      assertPolicyAudit(b.policyAudit, await candidateDigest(b), {
        requireQuestionStyle: true,
      });
      if (typeof b.prompt !== 'string' || questionIssues(b.prompt).length)
        throw Error('自动题目不符合当前标题、正文长度或表达要求');
      if (b.difficulty !== b.policyAudit.value.assessedDifficulty)
        throw Error('题目难度与独立审核等级不一致');
      const now = new Date().toISOString(),
        day = businessDate(now);
      const task: Task = {
        projectSeries: b.projectSeries,
        id: crypto.randomUUID(),
        title: text(b.title, '任务名称', 200),
        repoPath: text(b.repoPath, '仓库', 2000),
        stack: text(b.stack, '技术栈', 300),
        category: b.category,
        difficulty: b.difficulty,
        reproducibility: '待 Codex 环境检查',
        snapshot: '',
        createdAt: now,
        closed: false,
        automationMode: 'codex',
        autoGenerated: {
          fingerprint,
          tracePath: text(b.tracePath, '出题轨迹', 4000),
          generatedAt: now,
          policyAudit: b.policyAudit,
        },
        turns: [
          {
            id: crypto.randomUUID(),
            roundNumber: 1,
            prompt: text(b.prompt, '任务目标', 20000),
            category: b.category,
            difficulty: b.difficulty,
            status: 'queued',
            createdAt: now,
          },
        ],
      };
      task.turns[0].questionRootId = task.turns[0].id;
      // One SQL statement guards concurrent replenishment, daily quota and duplicate receipts.
      const inserted = await db()
        .prepare(`INSERT INTO tasks(id,data,created_at) SELECT ?,?,?
        WHERE (SELECT count(*) FROM tasks,json_each(tasks.data,'$.turns') r WHERE json_extract(r.value,'$.status')='queued') < 2
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE json_extract(data,'$.autoGenerated.fingerprint')=?)
        AND (SELECT count(*) FROM tasks WHERE json_extract(data,'$.autoGenerated') IS NOT NULL AND date(created_at,'+8 hours')=?) < ?
        AND COALESCE((SELECT json_extract(data,'$.enabled') FROM runners WHERE id='scheduler'),1)=1`)
        .bind(
          task.id,
          serializeTask(task),
          now,
          fingerprint,
          day,
          config.dailyLimit,
        )
        .run();
      return Response.json(
        inserted.meta.changes
          ? { taskId: task.id }
          : { skipped: '队列已补充或达到每日上限' },
      );
    }
    if (b.action === 'claim') {
      const tasks = await all(),
        config = await schedulerConfig();
      const capacity = Math.min(
        config.concurrency,
        Number.isInteger(b.capacity) ? Math.max(0, Math.min(4, b.capacity)) : 1,
      );
      if (capacity === 0) return Response.json({ job: null });
      const residents = Array.isArray(b.residentTaskIds)
        ? b.residentTaskIds
        : [];
      const ordered = [...tasks]
        .reverse()
        .sort(
          (a, b) =>
            Number(residents.includes(b.id)) - Number(residents.includes(a.id)),
        );
      for (const item of ordered) {
        if (
          Array.isArray(b.excludeTaskIds) &&
          b.excludeTaskIds.includes(item.id)
        )
          continue;
        if (b.allowNewContainer === false && !residents.includes(item.id))
          continue;
        if (
          item.closed ||
          item.turns.some(
            (r: any) => r.recoveryBlocked || r.status === 'running',
          )
        )
          continue;
        const r = item.turns.find((r: any) => r.status === 'queued');
        if (!r) continue;
        r.questionRootId ||= questionRoot(item, r);
        r.roundNumber = item.turns
          .slice(0, item.turns.indexOf(r) + 1)
          .filter(
            (x: Turn) => questionRoot(item, x) === r.questionRootId,
          ).length;
        item.automationMode = 'codex';
        r.status = 'running';
        if (!r.planRetry) r.startedAt ||= new Date().toISOString();
        r.jobToken = crypto.randomUUID();
        const { revision, ...task } = item;
        // Revision CAS and global running count are checked atomically, including simultaneous claims.
        const claimed = await db()
          .prepare(`UPDATE tasks SET data=?,revision=revision+1 WHERE id=? AND revision=?
          AND (SELECT count(*) FROM tasks,json_each(tasks.data,'$.turns') r WHERE json_extract(r.value,'$.status')='running') < ?`)
          .bind(serializeTask(task), task.id, revision, capacity)
          .run();
        if (claimed.meta.changes)
          return Response.json({ job: { task, turn: r } });
      }
      return Response.json({ job: null });
    }
    if (b.action === 'reserve-claude') {
      const item = await get(text(b.taskId, '任务 ID'));
      const r = item?.task.turns.find((r) => r.id === b.turnId);
      if (!item || !r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw Error('执行额度凭据无效');
      const attempt = text(b.attemptId, '调用标识', 200);
      const sessionId = b.sessionId
        ? text(b.sessionId, 'Claude 会话 ID', 300)
        : undefined;
      if (!sessionId && (!item.task.container || item.task.sessionId))
        throw Error('缺少现有会话 ID 或新容器记录');
      if (item.task.sessionId && item.task.sessionId !== sessionId)
        throw Error('不能在当前题目会话中切换 Claude SessionID');
      if (r.claudeAttempts?.includes(attempt))
        return Response.json({
          allowed: true,
          count: claudeCallCount(item.task, questionRoot(item.task, r)),
        });
      r.claudeAttempts ||= r.promptId || r.sessionId ? ['legacy'] : [];
      if (
        claudeCallCount(item.task, questionRoot(item.task, r)) >=
        sessionLimits.maxCalls
      )
        return Response.json({ allowed: false, count: 10 });
      // Reserve before spawning; even uncertain/failed calls retain their slot.
      r.claudeAttempts.push(attempt);
      if (sessionId) item.task.sessionId = sessionId;
      await save(item.task, item.revision);
      return Response.json({
        allowed: true,
        count: claudeCallCount(item.task, questionRoot(item.task, r)),
      });
    }
    if (b.action === 'container') {
      const item = await get(text(b.taskId, '任务 ID'));
      if (!item) throw Error('任务不存在');
      const container = validateContainerRecord(b.container, item.task.id);
      if (item.task.container && item.task.container.name !== container.name)
        throw Error('不能切换任务容器');
      if (item.task.container?.questionId !== container.questionId) {
        if (container.sessionId) item.task.sessionId = container.sessionId;
        else delete item.task.sessionId;
      }
      item.task.container = container;
      item.task.workDir = container.workDir;
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    if (b.action === 'stage') {
      const item = await get(text(b.taskId, '任务 ID'));
      const r = item?.task.turns.find((r) => r.id === b.turnId);
      if (!item || !r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw new Error('阶段更新凭据错误');
      if (
        ![
          'scaffold',
          'context',
          'prepare',
          'policy',
          'snapshot',
          'claude',
          'runtime-plan',
          'runtime-running',
          'runtime-diagnose',
          'score',
          'delivery',
          'next',
          'project-next',
        ].includes(b.stage)
      )
        throw new Error('未知阶段');
      r.stage = b.stage;
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    if (b.action === 'recover') {
      const item = await get(text(b.taskId, '任务 ID'));
      const r = item?.task.turns.find((r) => r.id === b.turnId);
      if (!item || !r) return Response.json({ done: true });
      if (r.completedJobToken === b.jobToken)
        return Response.json({ done: true });
      if (
        typeof b.jobToken !== 'string' ||
        (r.jobToken !== b.jobToken && r.recoveryToken !== b.jobToken)
      )
        return Response.json({ done: true });
      r.recoveryToken = b.jobToken;
      delete r.jobToken;
      r.status = 'failed';
      r.recoveryBlocked = b.live === true;
      r.error = b.live
        ? '旧执行器子进程仍在运行，暂不允许重试'
        : '执行器中断，结果未确认；请检查轨迹后决定重试或排除';
      if (!b.live && b.salvage?.success === true) {
        r.status = 'queued';
        r.error = '';
        for (const key of [
          'workDir',
          'sessionId',
          'snapshot',
          'harnessVersion',
          'os',
          'model',
        ] as const)
          if (typeof b.salvage[key] === 'string')
            item.task[key] = b.salvage[key];
      }
      if (!b.live) delete r.recoveryToken;
      await save(item.task, item.revision);
      return Response.json({ done: !b.live });
    }
    if (b.action === 'finish') {
      const item = await get(text(b.taskId, '任务 ID'));
      if (!item) throw new Error('任务不存在');
      const r = item.task.turns.find((r) => r.id === b.turnId);
      if (typeof b.jobToken === 'string' && r?.completedJobToken === b.jobToken)
        return Response.json({ ok: true });
      if (!r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw new Error('任务状态或执行凭据不匹配');
      if (
        b.success &&
        (r.automation?.submittedPolicyEvidence ||
          b.automation?.submittedPolicyEvidence)
      )
        throw Error('已发送题目审核异议必须保留失败状态，只能单独规划后续');
      if (b.success && b.contextCheck && !b.contextCheck.ready)
        throw Error('上下文未通过核验，不能标记执行成功');
      if (b.container) {
        const container = validateContainerRecord(b.container, item.task.id);
        const matchesQuestion =
          container.questionId === questionRoot(item.task, r);
        if (b.success && !matchesQuestion)
          throw Error('执行结果容器不属于本题');
        if (item.task.container && item.task.container.name !== container.name)
          throw Error('任务容器发生变化');
        if (b.success && !b.traceExport?.verified)
          throw Error('容器完整轨迹尚未导出核验');
        if (b.success && terminalIssues(b).length)
          throw Error(terminalIssues(b).join('；'));
        if (b.success && permissionIssues(b).length)
          throw Error(permissionIssues(b).join('；'));
        if (
          item.task.sessionId &&
          b.sessionId &&
          item.task.sessionId !== b.sessionId
        )
          throw Error('容器 SessionID 发生变化');
        item.task.container = container;
        if (matchesQuestion) {
          r.container = container;
          r.traceExport = b.traceExport;
          r.permissionAudit = b.permissionAudit;
        }
      }
      r.status = b.success ? 'review' : 'failed';
      r.roundNumber ||= roundNumber(item.task, r) || undefined;
      if (b.harness !== undefined) {
        if (!['Claude Code', 'Codex CLI'].includes(b.harness))
          throw Error('Harness 无效');
        if (item.task.harness && item.task.harness !== b.harness)
          throw Error('同一会话不能切换 Harness');
        r.harness = b.harness;
        item.task.harness = b.harness;
      }
      if (b.contextCheck && typeof b.contextCheck === 'object')
        r.contextCheck = b.contextCheck;
      if (b.success) delete r.planRetry;
      r.finishedAt =
        typeof b.finishedAt === 'string' && !isNaN(Date.parse(b.finishedAt))
          ? b.finishedAt
          : new Date().toISOString();
      if (b.automation && typeof b.automation === 'object')
        r.automation = b.automation;
      if (
        Array.isArray(b.evidence) &&
        JSON.stringify(b.evidence).length <= 65000 &&
        b.evidence.every(
          (x: any) =>
            x &&
            /^[a-z0-9_-]+$/.test(x.id) &&
            typeof x.label === 'string' &&
            typeof x.content === 'string',
        )
      )
        r.evidence = b.evidence;
      if (typeof b.stage === 'string') r.stage = b.stage;
      if (b.preparedPrompt) {
        r.requestedPrompt = r.requestedPrompt || r.prompt;
        text(b.preparedPrompt, 'Codex Prompt', 80000);
        r.prompt = b.preparedPrompt;
      }
      if (b.review?.source === 'codex') {
        const v = b.review;
        if (
          !Array.isArray(v.scores) ||
          v.scores.length !== 5 ||
          v.scores.some((x: any) => !Number.isInteger(x) || x < 1 || x > 5) ||
          !Array.isArray(v.descriptions) ||
          v.descriptions.length !== 5 ||
          v.descriptions.some((x: any) => typeof x !== 'string' || !x.trim())
        )
          throw new Error('Codex 评分无效');
        r.review = {
          ...v,
          source: 'codex',
          attested: false,
          reviewer: 'Codex CLI（AI）',
        };
      }
      if (b.preparation) {
        item.task.category = b.preparation.category;
        item.task.difficulty = b.preparation.difficulty;
        item.task.stack = b.preparation.stack;
        r.stack = b.preparation.stack;
        r.category = b.preparation.category;
        r.difficulty = b.preparation.difficulty;
      }
      r.sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      r.promptId = typeof b.promptId === 'string' ? b.promptId : undefined;
      if (typeof b.evaluationPrompt === 'string')
        r.evaluationPrompt = text(b.evaluationPrompt, '原始验收目标', 80000);
      if (['complete', 'truncated', 'error'].includes(b.executionOutcome))
        r.executionOutcome = b.executionOutcome;
      r.output = String(b.output || '').slice(0, 100000);
      r.error = String(b.error || '').slice(0, 10000);
      r.tracePath = String(b.tracePath || '');
      if (b.gatewayFailure) {
        const candidate = { ...r, gatewayFailure: b.gatewayFailure };
        if (b.success || !gatewayFailureValid(candidate))
          throw Error('504 原生失败证据无效');
        r.gatewayFailure = {
          version: gatewayContinuationVersion,
          status: 504,
          eventSha256: b.gatewayFailure.eventSha256,
          traceSha256: b.gatewayFailure.traceSha256,
          promptId: r.promptId!,
          sessionId: r.sessionId!,
        };
      }
      r.completedJobToken = r.jobToken;
      delete r.jobToken;
      for (const key of [
        'workDir',
        'harnessVersion',
        'os',
        'model',
        'sessionId',
      ] as const)
        if (typeof b[key] === 'string') item.task[key] = b[key];
      for (const key of ['harnessVersion', 'os', 'model'] as const)
        if (typeof b[key] === 'string') r[key] = b[key];
      if (
        (!item.task.snapshot || item.task.turns[0]?.id === r.id) &&
        typeof b.reproducibility === 'string'
      )
        item.task.reproducibility = b.reproducibility;
      if (b.githubSnapshot?.engine === 'github-cli')
        item.task.githubSnapshot = b.githubSnapshot;
      if (typeof b.reproducibility === 'string')
        r.reproducibility = text(b.reproducibility, '本轮环境等级', 300);
      if (!item.task.snapshot && typeof b.snapshot === 'string')
        item.task.snapshot = b.snapshot;
      const disputedPlan = !b.success && disputeContinuationReady(r);
      const recovery = planGatewayContinuation(item.task, r, {
        id: crypto.randomUUID(),
        callCount: claudeCallCount(item.task, questionRoot(item.task, r)),
      });
      if (recovery) {
        r.gatewayRecovery = {
          version: gatewayContinuationVersion,
          nextTurnId: recovery.id,
        };
        item.task.turns.push(recovery as Turn);
        item.task.automationNotice =
          '本轮已确认 504 结束，原会话排队发送继续；失败原件与实际轮次保留';
      }
      if ((b.success || disputedPlan) && !item.task.closed) {
        if (disputedPlan) delete r.planRetry;
        let decision;
        try {
          decision = nextDecision(item.task, r, await schedulerConfig());
        } catch (e) {
          r.automation ||= {};
          r.automation.nextError =
            e instanceof Error ? e.message : '后续规划无效';
          delete r.automation.next;
        }
        if (r.automation?.nextError)
          item.task.automationNotice =
            (disputedPlan ? '本轮出题异常已保留；' : '本轮已归档；') +
            '后续出题待重试：' +
            r.automation.nextError;
        if (decision) {
          item.task.automationNotice = decision.notice;
          r.sessionFinished =
            'finishSession' in decision && decision.finishSession === true;
          if (decision.prompt) {
            const id = crypto.randomUUID();
            if (disputedPlan) {
              r.automation!.projectContinuation!.state = 'continued';
              r.automation!.projectContinuation!.nextTurnId = id;
            }
            const continued = 'repairOf' in decision;
            item.task.turns.push({
              roundNumber: continued ? (r.roundNumber || 1) + 1 : 1,
              questionRootId: continued ? r.questionRootId || r.id : id,
              id,
              prompt: decision.prompt,
              ...('repairOf' in decision
                ? { repairOf: String(decision.repairOf) }
                : {}),
              category:
                ('category' in decision && decision.category) || r.category,
              difficulty:
                ('difficulty' in decision && decision.difficulty) ||
                r.difficulty,
              status: 'queued',
              createdAt: new Date().toISOString(),
              autoFollowup: true,
            });
          }
        }
      }
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    throw new Error('未知执行器操作');
  } catch (e) {
    return failure(e);
  }
}
