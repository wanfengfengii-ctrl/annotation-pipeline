import { repairDecision, canRepair } from '@/lib/project-series.mjs';
import { isContinuation } from '@/lib/round-context.mjs';
import { updateRecordMetadata } from '@/lib/record-metadata';
import { businessRecord } from '@/lib/business-record.mjs';
import { canAddTurn } from '@/lib/project-series.mjs';
import {
  projectQuotaComplete,
  validationRetryAllowed,
  historicalValidationRetryAllowed,
  unsentFailure,
  frozenPreparationFailure,
  closedRepairDraft,
} from '@/lib/project-recovery.mjs';
import { submissionIssues } from '@/lib/submission-policy.mjs';
import {
  canPlanDisputedTurn,
  blocksProject,
} from '@/lib/disputed-continuation.mjs';
import { get, save, failure, protect, text } from '@/db/store';
import {
  counted,
  pending,
  issues,
  categories,
  difficulties,
} from '@/lib/pipeline';
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    protect(req);
    const { id } = await params;
    const item = await get(id);
    if (!item) return failure(new Error('任务不存在'), 404);
    const { task: t, revision } = item;
    const b: any = await req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error('请求格式无效');
    if (b.revision !== revision) throw new Error('数据已更新，请刷新后重试');
    if (
      t.turns.find((r) => r.id === b.turnId)?.humanReview?.receipt &&
      ['review', 'retry', 'assess', 'exclude', 'trace'].includes(b.action)
    )
      throw Error('人工交付已登记，该轮已锁定');
    if (b.action === 'record-metadata') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r) throw Error('轮次不存在');
      const { origin, result } = businessRecord(t, r);
      if (result.receipt || result.humanReview?.receipt)
        throw Error('业务题已登记交付，审核字段已锁定');
      updateRecordMetadata(t, origin, b.metadata);
    } else if (b.action === 'enqueue') {
      if (!t.container && t.sessionId)
        throw Error('旧版宿主机会话仅保留记录，请创建新的容器任务');
      if (t.closed || pending(t)) throw Error('项目已结束或正在执行');
      if (
        !categories.includes(b.category) ||
        !difficulties.includes(b.difficulty) ||
        (!counted(t) && b.difficulty === '简单')
      )
        throw Error('题型或难度无效');
      if (t.turns.some(blocksProject)) throw Error('先处理未完成轮次');
      if (isContinuation(b.prompt))
        throw Error('只允许具体的 Bug 修复追问，不能仅填写继续');
      const previous = t.turns.at(-1),
        repair = b.category === 'Bug 修复';
      if (repair && !canRepair(t, previous))
        throw Error('当前会话无法追加 Bug 修复，最多初始题加两轮修复');
      if (!repair && !canAddTurn(t, b.category))
        throw Error('该题型额度已用完，0-1 与 Feature 各最多十题');
      if (t.projectSeries && !t.turns.length && b.category !== '0-1 代码生成')
        throw Error('连续项目首题必须为 0-1');
      const decision = repair
        ? repairDecision(t, previous, {
            prompt: b.prompt,
            reason: '用户追加具体问题',
            difficulty: b.difficulty,
          })
        : null;
      if (repair && !decision?.prompt)
        throw Error(decision?.notice || '无法追加修复');
      const id = crypto.randomUUID();
      t.turns.push({
        id,
        prompt: text(b.prompt, 'Prompt', 80000),
        category: b.category,
        difficulty: b.difficulty,
        status: 'queued',
        createdAt: new Date().toISOString(),
        roundNumber: repair ? (previous!.roundNumber || 1) + 1 : 1,
        questionRootId: repair ? decision!.questionRootId : id,
        ...(repair ? { repairOf: previous!.id } : {}),
      });
    } else if (b.action === 'retry') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (
        !r ||
        r.recoveryBlocked ||
        r.status !== 'failed' ||
        pending(t) ||
        t.closed
      )
        throw new Error('此轮不能重试');
      if (t.turns.at(-1)?.id !== r.id)
        throw Error('后续轮次已存在，不能重跑历史轮次覆盖原始证据');
      if (canPlanDisputedTurn(t, r)) r.planRetry = true;
      const archivedRepair = closedRepairDraft(t, r);
      const repairPreparation =
        !archivedRepair &&
        ((!!r.repairOf && r.stage === 'prepare' && unsentFailure(r)) ||
          frozenPreparationFailure(r));
      if (
        archivedRepair ||
        (r.projectRecovery?.state === 'blocked' &&
          !r.planRetry &&
          !repairPreparation)
      ) {
        // A user-requested retry after repairing the planner must continue that
        // planner, not replay the rejected question. Keep its attempt history;
        // planFailedProject rechecks idle state, source evidence and quotas.
        r.projectRetry = { originalStatus: r.status, originalStage: r.stage };
      }
      if (repairPreparation) {
        delete r.projectRetry;
        t.automationNotice = '题目尚未发送，保留原题和历史记录，重新准备题面';
      }
      if (r.stageRecovery && !r.planRetry && !r.projectRetry) {
        r.stageRecovery = {
          ...r.stageRecovery,
          attempts: r.stageRecovery.attempts + 1,
          retrying: true,
          originalStage: r.stageRecovery.originalStage || r.stage,
          queuedAt: new Date().toISOString(),
        };
      }
      r.status = 'queued';
      if (!r.projectRetry) r.error = '';
    } else if (b.action === 'retry-validation') {
      const r = t.turns.find((r) => r.id === b.turnId);
      const historical = historicalValidationRetryAllowed(t, r);
      if (!historical && !validationRetryAllowed(t, r))
        throw Error(
          '此轮不能仅重做验收：需代码已完成、原件齐全且没有交付锁定或题目审核异议',
        );
      r!.stageRecovery = {
        ...r!.stageRecovery,
        attempts: (r!.stageRecovery?.attempts || 0) + 1,
        retrying: true,
        validationOnly: true,
        historical,
        originalStage: r!.stageRecovery?.originalStage || r!.stage,
        originalError: r!.stageRecovery?.originalError || r!.error,
        queuedAt: new Date().toISOString(),
      };
      delete r!.projectRetry;
      delete r!.planRetry;
      r!.status = 'queued';
      t.automationNotice = '保留本题产物和原始轨迹，仅重做独立验收及评分';
    } else if (b.action === 'retry-plan') {
      const r = t.turns.at(-1);
      const disputed = canPlanDisputedTurn(t, r);
      if (
        !r ||
        r.id !== b.turnId ||
        (!disputed && (r.status !== 'review' || !r.automation?.nextError)) ||
        r.humanReview ||
        r.receipt ||
        t.closed ||
        pending(t)
      )
        throw Error('此轮不能重新规划后续任务');
      r.status = 'queued';
      r.planRetry = true;
    } else if (b.action === 'review') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || r.status !== 'review') throw new Error('此轮当前不可评分');
      if (r.review?.source === 'codex')
        throw new Error('Codex 评分保留机器来源，不可改为人工评分');
      const v = b.review;
      if (
        !v ||
        !Array.isArray(v.scores) ||
        v.scores.length !== 5 ||
        !Array.isArray(v.descriptions) ||
        v.descriptions.length !== 5
      )
        throw new Error('评分结构无效');
      if (
        v.scores.some(
          (x: unknown) =>
            !Number.isInteger(x) || Number(x) < 0 || Number(x) > 5,
        ) ||
        v.descriptions.some(
          (x: unknown) => typeof x !== 'string' || x.length > 20000,
        )
      )
        throw new Error('评分或描述无效');
      r.review = {
        source: 'human',
        scores: v.scores,
        descriptions: v.descriptions,
        reviewer:
          typeof v.reviewer === 'string' ? v.reviewer.slice(0, 100) : '',
        attested: v.attested === true,
        other: typeof v.other === 'string' ? v.other.slice(0, 20000) : '',
      };
    } else if (b.action === 'assess') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || r.status !== 'failed') throw new Error('该轮不是异常轮次');
      r.status = 'review';
    } else if (b.action === 'exclude') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || !['failed', 'review'].includes(r.status))
        throw new Error('此轮不可排除');
      r.excluded = true;
      r.excludeReason = text(b.reason, '工程故障说明', 3000);
    } else if (b.action === 'submit') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || issues(t, r).length) throw new Error('请先通过本轮形式校验');
      const submissionErrors = submissionIssues(t, r);
      if (submissionErrors.length) throw Error(submissionErrors.join('；'));
      if (r.receipt) throw Error('交付回执已登记，不可覆盖历史记录');
      r.status = 'submitted';
      r.submittedAt = new Date().toISOString();
      if (b.submitter) r.submitter = text(b.submitter, '提交人', 100);
      r.receipt = text(b.receipt, '外部提交记录', 2000);
    } else if (b.action === 'resume-project') {
      if (
        !t.projectSeries ||
        pending(t) ||
        t.turns.some((r) => r.recoveryBlocked) ||
        projectQuotaComplete(t)
      )
        throw Error('项目正在执行、状态待确认或两类实际题额已满');
      t.closed = false;
      t.automationNotice = '按用户要求保留原项目继续出题，原失败与禁传记录不变';
    } else if (b.action === 'close') {
      if (pending(t)) throw new Error('执行中的会话不能结束');
      t.closed = true;
    } else if (b.action === 'trace') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || !['review', 'failed'].includes(r.status))
        throw new Error('该轮不可修改');
      if (
        r.humanReview ||
        r.review?.source === 'codex' ||
        r.automation?.archive
      )
        throw Error('已有评分或归档，不能修改原始证据定位');
      r.promptId = text(b.promptId, '原始用户消息 PromptID', 300);
      r.tracePath = text(b.tracePath, '轨迹位置', 2000);
    } else throw new Error('未知操作');
    await save(t, revision);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
