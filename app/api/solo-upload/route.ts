import { db, failure, runnerAuth } from '@/db/store';
import { validateSoloStatusSnapshot } from '@/lib/solo-upload-status.mjs';
export async function POST(req: Request) {
  try {
    runnerAuth(req);
    const value = validateSoloStatusSnapshot(await req.json());
    const result = await db()
      .prepare(
        `INSERT INTO runners(id,data,heartbeat) VALUES('solo-upload',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,heartbeat=excluded.heartbeat WHERE excluded.heartbeat > runners.heartbeat`,
      )
      .bind(JSON.stringify(value), value.checkedAt)
      .run();
    return Response.json({ ok: true, updated: !!result.meta.changes });
  } catch (e) {
    return failure(e);
  }
}
