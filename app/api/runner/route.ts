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
            mode: 'Codex 编排 / Claude 执行',
            codexVersion:
              typeof b.codexVersion === 'string' ? b.codexVersion : '',
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
        item.automationMode = 'codex';
        r.status = 'running';
        r.startedAt = new Date().toISOString();
        r.jobToken = crypto.randomUUID();
        const { revision, ...task } = item;
        await save(task, revision);
        return Response.json({ job: { task, turn: r } });
      }
      return Response.json({ job: null });
    }
    if (b.action === 'stage') {
      const item = await get(text(b.taskId, '任务 ID'));
      const r = item?.task.turns.find((r) => r.id === b.turnId);
      if (!item || !r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw new Error('阶段更新凭据错误');
      if (
        !['prepare', 'snapshot', 'claude', 'score', 'delivery'].includes(
          b.stage,
        )
      )
        throw new Error('未知阶段');
      r.stage = b.stage;
      await save(item.task, item.revision);
      return Response.json({ ok: true });
    }
    if (b.action === 'finish') {
      const item = await get(text(b.taskId, '任务 ID'));
      if (!item) throw new Error('任务不存在');
      const r = item.task.turns.find((r) => r.id === b.turnId);
      if (typeof b.jobToken === 'string' && r?.completedJobToken === b.jobToken)
        return Response.json({ ok: true });
      if (!r || r.status !== 'running' || r.jobToken !== b.jobToken)
        throw new Error('任务状态或执行凭据不匹配');
      r.status = b.success ? 'review' : 'failed';
      r.finishedAt =
        typeof b.finishedAt === 'string' && !isNaN(Date.parse(b.finishedAt))
          ? b.finishedAt
          : new Date().toISOString();
      if (b.automation && typeof b.automation === 'object')
        r.automation = b.automation;
      if (typeof b.stage === 'string') r.stage = b.stage;
      if (b.preparedPrompt) {
        r.requestedPrompt = r.requestedPrompt || r.prompt;
        r.prompt = text(b.preparedPrompt, 'Codex Prompt', 80000);
      }
      if (b.review?.source === 'codex') {
        const v = b.review;
        if (
          !Array.isArray(v.scores) ||
          v.scores.length !== 5 ||
          v.scores.some((x: any) => !Number.isInteger(x) || x < 1 || x > 5) ||
          !Array.isArray(v.descriptions) ||
          v.descriptions.length !== 5 ||
          v.descriptions.some((x: any) => typeof x !== 'string' || !x.trim())
        )
          throw new Error('Codex 评分无效');
        r.review = {
          ...v,
          source: 'codex',
          attested: false,
          reviewer: 'Codex CLI（AI）',
        };
      }
      if (b.preparation) {
        item.task.category = b.preparation.category;
        item.task.difficulty = b.preparation.difficulty;
        item.task.stack = b.preparation.stack;
        r.category = b.preparation.category;
        r.difficulty = b.preparation.difficulty;
      }
      r.sessionId = typeof b.sessionId === 'string' ? b.sessionId : undefined;
      r.promptId = typeof b.promptId === 'string' ? b.promptId : undefined;
      r.output = String(b.output || '').slice(0, 100000);
      r.error = String(b.error || '').slice(0, 10000);
      r.tracePath = String(b.tracePath || '');
      r.completedJobToken = r.jobToken;
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
