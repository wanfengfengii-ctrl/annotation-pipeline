import { all, db, failure } from '@/db/store';
import { monitorTask } from '@/lib/monitor-source.mjs';
export async function GET() {
  try {
    const tasks = await all();
    const runner = await db()
      .prepare("SELECT data,heartbeat FROM runners WHERE id='local'")
      .first<{ data: string; heartbeat: string }>();
    return Response.json(
      {
        tasks: tasks.map(monitorTask),
        runner: runner
          ? { ...JSON.parse(runner.data), heartbeat: runner.heartbeat }
          : null,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return failure(e, 500);
  }
}
