import { env } from 'cloudflare:workers';
import type { Task } from '@/lib/pipeline';
export function db() {
  return (env as unknown as { DB: D1Database }).DB;
}
export async function all() {
  const { results } = await db()
    .prepare('SELECT data, revision FROM tasks ORDER BY created_at DESC')
    .all<{ data: string; revision: number }>();
  return results.map((r) => ({ ...JSON.parse(r.data), revision: r.revision }));
}
export async function get(id: string) {
  const row = await db()
    .prepare('SELECT data, revision FROM tasks WHERE id=?')
    .bind(id)
    .first<{ data: string; revision: number }>();
  return row
    ? { task: JSON.parse(row.data) as Task, revision: row.revision }
    : null;
}
export async function save(task: Task, revision: number) {
  const r = await db()
    .prepare(
      'UPDATE tasks SET data=?, revision=revision+1 WHERE id=? AND revision=?',
    )
    .bind(JSON.stringify(task), task.id, revision)
    .run();
  if (!r.meta.changes) throw new Error('数据已更新，请刷新后重试');
}
export function failure(error: unknown, status = 400) {
  return Response.json(
    { error: error instanceof Error ? error.message : '请求失败' },
    { status },
  );
}
export function protect(req: Request) {
  if (req.method !== 'GET') {
    const o = req.headers.get('origin');
    if (o && o !== new URL(req.url).origin) throw new Error('不允许跨来源写入');
  }
}
export function runnerAuth(req: Request) {
  const token = (env as unknown as { RUNNER_TOKEN?: string }).RUNNER_TOKEN;
  if (!token || req.headers.get('authorization') !== `Bearer ${token}`)
    throw new Error('执行器认证失败');
}
export function text(value: unknown, name: string, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name}无效`);
  return value.trim();
}
