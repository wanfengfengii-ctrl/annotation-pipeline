import { db, get, failure, protect, text } from '@/db/store';
import { saveHumanReview } from '@/db/human-review';
import {
  normalizeHumanDraft,
  draftFromAI,
  humanDraftIssues,
  humanQualityReasons,
  humanIssues,
} from '@/lib/human-review';
import type { HumanReview } from '@/lib/human-review';
import { submissionIssues } from '@/lib/submission-policy.mjs';
import {
  businessRecord,
  businessRecordOrigins,
} from '@/lib/business-record.mjs';
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const turnId = text(new URL(req.url).searchParams.get('turnId'), '轮次');
    const item = await get(id),
      input = item?.task.turns.find((r) => r.id === turnId);
    if (!item || !input) throw Error('轮次不存在');
    const { origin, result: turn } = businessRecord(item.task, input);
    const rows = await db()
      .prepare(
        'SELECT id,action,data,created_at FROM review_history WHERE task_id=? AND turn_id=? ORDER BY created_at DESC',
      )
      .bind(id, turn.id)
      .all<{ id: string; action: string; data: string; created_at: string }>();
    return Response.json(
      {
        taskId: id,
        turnId: origin.id,
        resultTurnId: turn.id,
        originalAI: turn.review,
        confirmation: turn.humanReview,
        snapshot: item.task.snapshot,
        sessionId: turn.sessionId,
        promptId: origin.promptId,
        prompt: origin.prompt,
        tracePath: turn.tracePath,
        archive: turn.automation?.archive,
        history: rows.results.map((r) => ({ ...r, data: JSON.parse(r.data) })),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          ...(new URL(req.url).searchParams.has('download')
            ? {
                'Content-Disposition':
                  'attachment; filename=human-confirmation.json',
              }
            : {}),
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    protect(req);
    const { id } = await params,
      item = await get(id);
    if (!item) throw Error('任务不存在');
    const b = (await req.json()) as Record<string, unknown>;
    if (b.revision !== item.revision)
      throw Error('数据已更新，请刷新后重试；未保存草稿仍留在页面');
    const input = item.task.turns.find((r) => r.id === b.turnId);
    const r = input && businessRecord(item.task, input).result;
    if (
      !r ||
      r.review?.source !== 'codex' ||
      r.excluded ||
      !['review', 'submitted'].includes(r.status)
    )
      throw Error('该轮暂不可人工评审');
    const action = text(b.action, '操作');
    if (r.humanReview?.receipt) throw Error('已登记交付，人工记录已锁定');
    const now = new Date().toISOString();
    const h: HumanReview = r.humanReview || {
      draft: draftFromAI(r),
      state: 'draft',
      source: 'human-assisted',
      updatedAt: now,
      qualityReasons: [],
    };
    let actor = '';
    if (action === 'save' || action === 'finalize') {
      const draft = normalizeHumanDraft(b.draft);
      actor = text(draft.reviewer, '实际评审人', 100);
      const errors = humanDraftIssues(r, draft);
      if (action === 'finalize' && errors.length)
        throw Error(errors.join('；'));
      h.draft = draft;
      delete h.reworkReason;
      delete h.submittedAt;
      h.qualityReasons =
        action === 'finalize' ? humanQualityReasons(r, draft) : [];
      h.state =
        action === 'save'
          ? 'draft'
          : h.qualityReasons.length && !draft.qualityResolution
            ? 'needs_second_review'
            : 'approved';
      if (action === 'finalize') h.submittedAt = now;
    } else if (action === 'return') {
      actor = text(b.actor, '确认人', 100);
      h.state = 'needs_revision';
      h.reworkReason = text(b.reason, '需补充的证据或修改说明', 3000);
    } else if (action === 'receipt') {
      const errors = [
        ...humanIssues(item.task, r),
        ...submissionIssues(item.task, r),
      ];
      if (errors.length) throw Error(errors.join('；'));
      if (b.allRoundsChecked !== true)
        throw Error('请核对全部有效轮次后登记交付');
      const missing = businessRecordOrigins(item.task)
        .filter((x) => !x.excluded)
        .map((x) => businessRecord(item.task, x).result)
        .filter((x) => !x.excluded && humanIssues(item.task, x).length);
      if (missing.length)
        throw Error(`还有 ${missing.length} 个有效轮次未完成人工质检`);
      actor = text(b.actor, '登记人', 100);
      h.submitter = actor;
      h.receipt = text(b.receipt, '外部实际回执', 2000);
      h.deliveredAt = now;
    } else throw Error('未知人工评审操作');
    h.updatedAt = now;
    r.humanReview = h;
    await saveHumanReview(item.task, item.revision, r.id, action, actor);
    return Response.json({ ok: true, review: h });
  } catch (e) {
    return failure(e);
  }
}
