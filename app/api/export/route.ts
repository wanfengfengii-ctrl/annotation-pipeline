import { all, failure } from '@/db/store';
import { csv, businessDate, type Turn } from '@/lib/pipeline';
export async function GET(req: Request) {
  try {
    const day = new URL(req.url).searchParams.get('day');
    if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day))))
      throw Error('日期格式无效');
    const tasks = await all();
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
