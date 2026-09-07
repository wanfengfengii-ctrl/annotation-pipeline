import { all, failure } from '@/db/store';
import { csv } from '@/lib/pipeline';
export async function GET() {
  try {
    return new Response(csv(await all()), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="annotation-delivery.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return failure(e, 500);
  }
}
