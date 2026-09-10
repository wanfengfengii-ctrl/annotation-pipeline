import { selectRecords } from '@/db/records';
import { recordFilter, type RecordRow } from '@/lib/record-fields';
import { xlsx, recordsCsv } from '@/lib/xlsx';
import { exportScope, recordSelection } from '@/lib/record-selection';
import { terminalIssues } from '@/lib/terminal-policy.mjs';
import { permissionIssues } from '@/lib/permission-audit.mjs';
import { submissionIssues } from '@/lib/submission-policy.mjs';
import { all, failure, db, protect, text } from '@/db/store';
import { csv, type Task } from '@/lib/pipeline';
import {
  sanitizeExportRows,
  sanitizeExportCsv,
  exportSafetyHeaders,
} from '@/lib/export-safety.mjs';
import { env } from 'cloudflare:workers';
const downloadOptions = () => ({
  knownSecrets: Object.entries(env)
    .filter(
      ([key, value]) =>
        /(?:TOKEN|KEY|SECRET|PASSWORD)/i.test(key) &&
        typeof value === 'string' &&
        value.length > 0,
    )
    .map(([, value]) => value as string),
});
export async function GET(req: Request) {
  try {
    const day = new URL(req.url).searchParams.get('day');
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day))))
      throw Error('日期格式无效');
    const tasks = await all();
    const source = new URL(req.url).searchParams.get('source');
    if (source && source !== 'human') throw Error('导出来源无效');
    const safe = sanitizeExportCsv(
      csv(tasks, source === 'human' ? 'human' : 'primary', day || undefined),
      downloadOptions(),
    );
    return new Response(safe.text, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="annotation-delivery.safe.csv"',
        'Cache-Control': 'no-store',
        ...exportSafetyHeaders(safe.safety),
      },
    });
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
      scope = exportScope(b.scope),
      selected = scope === 'selected' ? recordSelection(b.selected) : undefined;
    const signature = JSON.stringify({
      filter,
      format,
      scope,
      ...(selected ? { selected } : {}),
    });
    const existing = await db()
      .prepare('SELECT filter FROM export_batches WHERE id=?')
      .bind(id)
      .first<{ filter: string }>();
    if (existing && existing.filter !== signature)
      throw Error('同一导出请求不能更改筛选条件');
    if (!existing) {
      const rows = (await selectRecords(filter, scope, selected)).rows.filter(
        (r) => r.eligible,
      );
      if (selected && rows.length !== selected.length)
        throw Error(
          '勾选记录已变化、未通过校验或不在当前筛选范围内，请刷新后重新勾选；本次未导出',
        );
      if (!rows.length) throw Error('当前范围没有通过校验的可导出轮次');
      // Build before recording: an invalid Excel field never increments the count.
      const safe = sanitizeExportRows(rows, downloadOptions());
      if (format === 'xlsx') xlsx(safe.rows, id, safe.safety);
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
    // A later denial in the same session also invalidates a saved batch download.
    // Retain the original batch bytes and export counts; do not rewrite its history.
    const current = await db()
      .prepare(
        'SELECT DISTINCT t.id,t.data FROM tasks t JOIN export_items e ON e.task_id=t.id WHERE e.batch_id=?',
      )
      .bind(id)
      .all<{ id: string; data: string }>();
    const tasks = new Map(
      current.results.map((t) => [t.id, JSON.parse(t.data) as Task]),
    );
    for (const row of rows) {
      const task = tasks.get(row.taskId),
        turn = task?.turns.find((r) => r.id === row.turnId);
      if (!task || !turn) throw Error('该批次的原始轮次已缺失，不能重新导出');
      const submissionErrors = submissionIssues(task, turn);
      if (submissionErrors.length) throw Error(submissionErrors.join('；'));
      if (
        turn?.container &&
        (terminalIssues(turn).length ||
          permissionIssues(turn).length ||
          task?.turns.some(
            (r) =>
              r.sessionId === turn.sessionId &&
              r.permissionAudit &&
              !r.permissionAudit.passed,
          ))
      )
        throw Error('该批次包含权限核验未通过的会话，原记录已保留，请重新采集');
    }
    const safe = sanitizeExportRows(rows, downloadOptions());
    return new Response(
      format === 'xlsx'
        ? (xlsx(safe.rows, id, safe.safety) as unknown as BodyInit)
        : recordsCsv(safe.rows),
      {
        headers: {
          'Content-Type':
            format === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="annotation-${id}.safe.${format}"`,
          'Cache-Control': 'no-store',
          'X-Export-Count': String(rows.length),
          'X-Export-Batch': id,
          ...exportSafetyHeaders(safe.safety),
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
