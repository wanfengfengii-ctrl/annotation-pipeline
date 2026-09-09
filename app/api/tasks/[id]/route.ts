import { isContinuation } from '@/lib/round-context.mjs';
import { updateRecordMetadata } from '@/lib/record-metadata';
import { canAddTurn } from '@/lib/project-series.mjs';
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
      updateRecordMetadata(t, r, b.metadata);
    } else if (b.action === 'enqueue') {
      if (t.closed || pending(t) || !canAddTurn(t))
        throw new Error('会话已结束、正在执行或已达到 10 轮上限');
      if (
        !categories.includes(b.category) ||
        !difficulties.includes(b.difficulty) ||
        (!counted(t) && b.difficulty === '简单')
      )
        throw new Error('题型或难度无效');
      if (t.turns.some((r) => r.status === 'failed' && !r.excluded))
        throw Error('先处理未完成的轮次，避免后续代码覆盖待评分产物');
      const previous = t.turns.at(-1);
      const continuing = isContinuation(b.prompt);
      if (continuing && (!previous || previous.excluded))
        throw Error('没有可继续的有效轮次');
      if (continuing) {
        b.category = previous!.category;
        b.difficulty = previous!.difficulty;
      }
      if (
        t.projectSeries &&
        !continuing &&
        ((t.turns.length === 0 && b.category !== '0-1 代码生成') ||
          (t.turns.length > 0 && b.category === '0-1 代码生成'))
      )
        throw Error('项目首题须为 0-1，后续题须基于已有项目');
      t.turns.push({
        roundNumber: t.turns.length + 1,
        id: crypto.randomUUID(),
        prompt: text(b.prompt, 'Prompt', 80000),
        ...(continuing
          ? {
              continuationOf: previous!.id,
              evaluationPrompt: previous!.evaluationPrompt || previous!.prompt,
            }
          : {}),
        category: b.category,
        difficulty: b.difficulty,
        status: 'queued',
        createdAt: new Date().toISOString(),
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
      r.status = 'queued';
      r.error = '';
    } else if (b.action === 'retry-plan') {
      const r = t.turns.at(-1);
      if (
        !r ||
        r.id !== b.turnId ||
        r.status !== 'review' ||
        !r.automation?.nextError ||
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
      if (r.receipt) throw Error('交付回执已登记，不可覆盖历史记录');
      r.status = 'submitted';
      r.submittedAt = new Date().toISOString();
      if (b.submitter) r.submitter = text(b.submitter, '提交人', 100);
      r.receipt = text(b.receipt, '外部提交记录', 2000);
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
