import { db, get, failure } from '@/db/store';
import { deliveryIndexes } from '@/lib/delivery-index.mjs';
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const found = await get(id);
    if (!found) return Response.json({ error: '任务不存在' }, { status: 404 });
    const requested = new URL(_req.url).searchParams.get('version');
    if (requested) {
      if (!/^[a-f0-9]{64}$/.test(requested)) throw Error('交付版本无效');
      const saved = await db()
        .prepare(
          'SELECT data FROM delivery_indexes WHERE task_id=? AND version=?',
        )
        .bind(id, requested)
        .first<{ data: string }>();
      if (!saved)
        return Response.json({ error: '交付版本不存在' }, { status: 404 });
      return Response.json(JSON.parse(saved.data), {
        headers: { 'cache-control': 'no-store' },
      });
    }
    const [history, status] = await Promise.all([
      db()
        .prepare(
          'SELECT turn_id AS turnId,batch_id AS batchId FROM export_items WHERE task_id=?',
        )
        .bind(id)
        .all(),
      db()
        .prepare("SELECT data FROM runners WHERE id='solo-upload'")
        .first<{ data: string }>(),
    ]);
    const entries = deliveryIndexes(found.task, {
      exports: history.results,
      uploads: status ? JSON.parse(status.data).entries : {},
    });
    for (const entry of entries) {
      const e = entry as any;
      if (e.product) {
        const inventory = JSON.stringify({
          files: [...e.product.files].sort((a: any, b: any) =>
            a.path.localeCompare(b.path),
          ),
          omitted: [...e.product.omitted].sort(),
        });
        const bytes = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(inventory),
        );
        e.product.sha256 = Array.from(new Uint8Array(bytes), (x) =>
          x.toString(16).padStart(2, '0'),
        ).join('');
      }
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(entries)),
    );
    const version = Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, '0'),
    ).join('');
    const value = { taskId: id, revision: found.revision, version, entries };
    // Materialization is append-only and cannot update the task or admission.
    await db()
      .prepare(
        'INSERT INTO delivery_indexes(task_id,version,data,created_at) VALUES(?,?,?,?) ON CONFLICT(task_id,version) DO NOTHING',
      )
      .bind(id, version, JSON.stringify(value), new Date().toISOString())
      .run();
    const versionHistory = await db()
      .prepare(
        'SELECT version,created_at AS createdAt FROM delivery_indexes WHERE task_id=? ORDER BY created_at DESC LIMIT 100',
      )
      .bind(id)
      .all();
    return Response.json(
      { ...value, versions: versionHistory.results },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return failure(e);
  }
}
