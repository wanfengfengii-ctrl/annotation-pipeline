import { failure } from '@/db/store';
import { selectRecords } from '@/db/records';
import { recordFilter, recordHeaders } from '@/lib/record-fields';
export async function GET(req: Request) {
  try {
    return Response.json(
      {
        ...(await selectRecords(
          recordFilter(Object.fromEntries(new URL(req.url).searchParams)),
        )),
        headers: recordHeaders,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return failure(e);
  }
}
