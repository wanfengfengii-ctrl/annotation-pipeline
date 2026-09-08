import { selectRecords } from '@/db/records';
import { recordFilter, type RecordRow } from '@/lib/record-fields';
import { xlsx, recordsCsv } from '@/lib/xlsx';
import { all, failure, db, protect, text } from '@/db/store';
import { csv, businessDate, type Turn } from '@/lib/pipeline';
export async function GET(req: Request) {
  try {
    const day = new URL(req.url).searchParams.get('day');
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day))))
      throw Error('日期格式无效');
    const tasks = await all();
    const source = new URL(req.url).searchParams.get('source');
    if (source && source !== 'human') throw Error('导出来源无效');
    return new Response(
      csv(
        day
          ? tasks.map((t) => ({
              ...t,
              turns: t.turns.filter(
                (r: Turn) => businessDate(r.finishedAt || r.createdAt) === day,
              ),
            }))
          : tasks,
        source === 'human' ? 'human' : 'primary',
      ),
      {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="annotation-delivery.csv"',
          'Cache-Control': 'no-store',
        },
      },
    );
  } catch (e) {
    return failure(e, 500);
  }
}

export async function POST(req: Request) {
  try {
    protect(req);
    const b = (await req.json()) as Record<string, unknown>;
    const id = text(b.requestId, '导出请求', 100);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('导出请求标识无效');
    const filter = recordFilter((b.filter || {}) as Record<string, unknown>),
      format = b.format === 'csv' ? 'csv' : 'xlsx',
      scope = b.scope === 'page' ? 'page' : 'filtered';
    const signature = JSON.stringify({ filter, format, scope });
    const existing = await db()
      .prepare('SELECT filter FROM export_batches WHERE id=?')
      .bind(id)
      .first<{ filter: string }>();
    if (existing && existing.filter !== signature)
      throw Error('同一导出请求不能更改筛选条件');
    if (!existing) {
      const rows = (await selectRecords(filter, scope)).rows.filter(
        (r) => r.eligible,
      );
      if (!rows.length) throw Error('当前范围没有通过校验的可导出轮次');
      // Build before recording: an invalid Excel field never increments the count.
      if (format === 'xlsx') xlsx(rows, id);
      else if (JSON.stringify(rows).length > 16000000)
        throw Error('导出内容超过 16MB，请分批导出');
      const now = new Date().toISOString(),
        nonce = crypto.randomUUID();
      await db().batch([
        db()
          .prepare(
            'INSERT INTO export_batches(id,nonce,filter,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING',
          )
          .bind(id, nonce, signature, now),
        ...rows.map((r) =>
          db()
            .prepare(
              'INSERT INTO export_items(batch_id,task_id,turn_id,source,snapshot,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM export_batches WHERE id=? AND nonce=?) ON CONFLICT(batch_id,task_id,turn_id) DO NOTHING',
            )
            .bind(
              id,
              r.taskId,
              r.turnId,
              r.source,
              JSON.stringify(r),
              now,
              id,
              nonce,
            ),
        ),
      ]);
    }
    const batch = await db()
      .prepare('SELECT filter FROM export_batches WHERE id=?')
      .bind(id)
      .first<{ filter: string }>();
    if (batch?.filter !== signature) throw Error('导出请求冲突，请重新导出');
    const saved = await db()
      .prepare(
        'SELECT snapshot FROM export_items WHERE batch_id=? ORDER BY rowid',
      )
      .bind(id)
      .all<{ snapshot: string }>();
    const rows = saved.results.map((x) => JSON.parse(x.snapshot) as RecordRow);
    return new Response(
      format === 'xlsx'
        ? (xlsx(rows, id) as unknown as BodyInit)
        : recordsCsv(rows),
      {
        headers: {
          'Content-Type':
            format === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="annotation-${id}.${format}"`,
          'Cache-Control': 'no-store',
          'X-Export-Count': String(rows.length),
          'X-Export-Batch': id,
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
