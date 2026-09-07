import { all, get, save, db, failure, runnerAuth, text } from '@/db/store';
export async function POST(req: Request) {
  try {
    runnerAuth(req);
    const b: any = await req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error('请求格式无效');
    if (b.action === 'heartbeat') {
      await db()
        .prepare(
          'INSERT INTO runners(id,data,heartbeat) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,heartbeat=excluded.heartbeat',
        )
        .bind(
          'local',
          JSON.stringify({
            version: text(b.version, '版本', 200),
            mode: 'Claude CLI 配置模型',
          }),
          new Date().toISOString(),
        )
        .run();
      return Response.json({ ok: true });
    }
    if (b.action === 'claim') {
      const tasks = await all();
      if (tasks.some((t) => t.turns.some((r: any) => r.status === 'running')))
        return Response.json({ job: null });
      for (const item of [...tasks].reverse()) {
        const r = item.turns.find((r: any) => r.status === 'queued');
        if (!r) continue;
        r.status = 'running';
        r.jobToken = crypto.randomUUID();
        const { revision, ...task } = item;
        await save(task, revision);
        return Response.json({ job: { task, turn: r } });
      }
      return Response.json({ job: null });
    }
    if (b.action === 'finish') {
      const item = await get(text(b.taskId, '任务 ID'));
      if (!item) throw new Error('任务不存在');
      const r = item.task.turns.find((r) => r.id === b.turnId);
      if (!r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw new Error('任务状态或执行凭据不匹配');
      r.status = b.success ? 'review' : 'failed';
      r.finishedAt = new Date().toISOString();
      r.sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      r.promptId = typeof b.promptId === 'string' ? b.promptId : undefined;
      r.output = String(b.output || '').slice(0, 100000);
      r.error = String(b.error || '').slice(0, 10000);
      r.tracePath = String(b.tracePath || '');
      delete r.jobToken;
      for (const key of [
        'workDir',
        'harnessVersion',
        'os',
        'model',
        'sessionId',
      ] as const)
        if (typeof b[key] === 'string') item.task[key] = b[key];
      if (!item.task.snapshot && typeof b.snapshot === 'string')
        item.task.snapshot = b.snapshot;
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    throw new Error('未知执行器操作');
  } catch (e) {
    return failure(e);
  }
}
