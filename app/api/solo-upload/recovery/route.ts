import { db, failure, protect, runnerAuth } from '@/db/store';
import { canRequestBatchRecovery } from '@/lib/upload-batches.mjs';
export async function GET(req: Request) {
  try {
    runnerAuth(req);
    const { results } = await db()
      .prepare(
        "SELECT id,data FROM runners WHERE id LIKE 'solo-recovery:%' ORDER BY heartbeat LIMIT 100",
      )
      .all<{ id: string; data: string }>();
    return Response.json(
      { requests: results.map((r) => ({ ...JSON.parse(r.data), id: r.id })) },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return failure(e, 403);
  }
}
export async function POST(req: Request) {
  try {
    protect(req);
    const b = (await req.json()) as {
      action: string;
      slot?: string;
      revision?: string;
      id?: string;
    };
    if (b.action === 'ack') {
      runnerAuth(req);
      if (!/^solo-recovery:[a-f0-9]{64}$/.test(b.id || ''))
        throw Error('恢复请求标识无效');
      await db().prepare('DELETE FROM runners WHERE id=?').bind(b.id).run();
      return Response.json({ ok: true });
    }
    if (!['localhost', '127.0.0.1'].includes(new URL(req.url).hostname))
      throw Error('批次恢复仅限本机工作台');
    if (b.action !== 'request' || typeof b.revision !== 'string')
      throw Error('恢复请求无效');
    const row = await db()
      .prepare("SELECT data FROM runners WHERE id='solo-upload'")
      .first<{ data: string }>();
    const batch =
      row &&
      JSON.parse(row.data).batches?.find(
        (r: any) => r.slot === b.slot && r.revision === b.revision,
      );
    if (!batch?.rows?.length || !canRequestBatchRecovery(batch))
      throw Error('批次已变化或正在执行，请刷新后核对');
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([b.slot, b.revision])),
    );
    const id =
      'solo-recovery:' +
      Array.from(new Uint8Array(digest), (x) =>
        x.toString(16).padStart(2, '0'),
      ).join('');
    const at = new Date().toISOString();
    await db()
      .prepare(
        'INSERT INTO runners(id,data,heartbeat) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        id,
        JSON.stringify({ slot: b.slot, revision: b.revision, requestedAt: at }),
        at,
      )
      .run();
    return Response.json({
      ok: true,
      message: '已排队重新核验，由原上传任务在允许窗口处理本批',
    });
  } catch (e) {
    return failure(e);
  }
}
