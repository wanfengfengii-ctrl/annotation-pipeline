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
    if (b.action === 'enqueue') {
      if (t.closed || pending(t) || counted(t) >= 10)
        throw new Error('会话已结束、正在执行或已达到 10 轮上限');
      if (
        !categories.includes(b.category) ||
        !difficulties.includes(b.difficulty) ||
        (!counted(t) && b.difficulty === '简单')
      )
        throw new Error('题型或难度无效');
      t.turns.push({
        id: crypto.randomUUID(),
        prompt: text(b.prompt, 'Prompt', 80000),
        category: b.category,
        difficulty: b.difficulty,
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
    } else if (b.action === 'review') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || r.status !== 'review') throw new Error('此轮当前不可评分');
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
      r.status = 'submitted';
      r.submittedAt = new Date().toISOString();
      r.receipt = text(b.receipt, '外部提交记录', 2000);
    } else if (b.action === 'close') {
      if (pending(t)) throw new Error('执行中的会话不能结束');
      t.closed = true;
    } else if (b.action === 'trace') {
      const r = t.turns.find((r) => r.id === b.turnId);
      if (!r || !['review', 'failed'].includes(r.status))
        throw new Error('该轮不可修改');
      r.promptId = text(b.promptId, '原始用户消息 PromptID', 300);
      r.tracePath = text(b.tracePath, '轨迹位置', 2000);
    } else throw new Error('未知操作');
    await save(t, revision);
    return Response.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
