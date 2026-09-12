import { db, failure } from '@/db/store';
export async function GET() {
  try {
    const row = await db()
      .prepare("SELECT data,heartbeat FROM runners WHERE id='operations'")
      .first<{ data: string; heartbeat: string }>();
    return Response.json(
      { operations: row ? JSON.parse(row.data) : null },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (e) {
    return failure(e, 500);
  }
}
