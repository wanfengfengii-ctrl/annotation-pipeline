import { db } from './store';
import type { Task } from '@/lib/pipeline';
export async function saveHumanReview(
  task: Task,
  revision: number,
  turnId: string,
  action: string,
  actor: string,
) {
  const h = task.turns.find((r) => r.id === turnId)?.humanReview;
  const results = await db().batch([
    db()
      .prepare(
        'INSERT INTO review_history(id,task_id,turn_id,action,data,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND revision=?)',
      )
      .bind(
        crypto.randomUUID(),
        task.id,
        turnId,
        action,
        JSON.stringify({ actor, review: h }),
        new Date().toISOString(),
        task.id,
        revision,
      ),
    db()
      .prepare(
        'UPDATE tasks SET data=?, revision=revision+1 WHERE id=? AND revision=?',
      )
      .bind(JSON.stringify(task), task.id, revision),
  ]);
  if (!results[1].meta.changes)
    throw Error('数据已更新，草稿仍保留在页面；刷新后重试');
}
