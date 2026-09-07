import { db, failure, protect } from '@/db/store';
import { schedulerConfig } from '@/db/scheduler';
import { normalizeConfig } from '@/lib/scheduler';
export async function GET() {
  return Response.json({ config: await schedulerConfig() });
}
export async function POST(req: Request) {
  try {
    protect(req);
    const config = normalizeConfig(await req.json());
    await db()
      .prepare(
        "INSERT INTO runners(id,data,heartbeat) VALUES('scheduler',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,heartbeat=excluded.heartbeat",
      )
      .bind(JSON.stringify(config), new Date().toISOString())
      .run();
    return Response.json({ config });
  } catch (e) {
    return failure(e);
  }
}
