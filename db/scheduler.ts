import { db } from './store';
import { defaultScheduler, type SchedulerConfig } from '@/lib/scheduler';
export async function schedulerConfig(): Promise<SchedulerConfig> {
  const row = await db()
    .prepare("SELECT data FROM runners WHERE id='scheduler'")
    .first<{ data: string }>();
  return row
    ? { ...defaultScheduler, ...JSON.parse(row.data) }
    : { ...defaultScheduler };
}
