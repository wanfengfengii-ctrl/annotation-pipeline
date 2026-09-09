import { seriesVersion } from '@/lib/project-series.mjs';
import {
  all,
  get,
  ensureProjectNames,
  db,
  failure,
  protect,
  text,
} from '@/db/store';
import { categories, difficulties, type Task } from '@/lib/pipeline';
export async function GET() {
  try {
    const tasks = await all();
    const runner = await db()
      .prepare("SELECT data,heartbeat FROM runners WHERE id='local'")
      .first<{ data: string; heartbeat: string }>();
    return Response.json({
      tasks: tasks.map((t) => ({
        ...t,
        turns: t.turns.map(
          ({ jobToken, completedJobToken, recoveryToken, ...r }: any) => r,
        ),
      })),
      runner: runner
        ? { ...JSON.parse(runner.data), heartbeat: runner.heartbeat }
        : null,
    });
  } catch (e) {
    return failure(e, 500);
  }
}
export async function POST(req: Request) {
  try {
    protect(req);
    const b: any = await req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b))
      throw new Error('请求格式无效');
    if (
      !categories.includes(b.category) ||
      !difficulties.includes(b.difficulty) ||
      b.difficulty === '简单'
    )
      throw new Error('首轮须选择有效题型，且不能为简单题');
    if (b.category === 'Bug 修复')
      throw Error('Bug 修复必须在已有题目的会话中追加');
    if (b.projectSeries === true && b.category !== '0-1 代码生成')
      throw Error('连续项目的首题必须为 0-1 代码生成');
    const task: Task = {
      ...(b.projectSeries === true
        ? {
            projectSeries: {
              version: seriesVersion,
              directory: 'projects/p-' + crypto.randomUUID(),
            },
          }
        : {}),
      id: crypto.randomUUID(),
      title: text(b.title, '任务目标', 200),
      repoPath: text(b.repoPath, '本机仓库路径', 2000),
      stack: text(b.stack || '待 Codex 识别', '语言/框架', 300),
      category: b.category,
      difficulty: b.difficulty,
      reproducibility: text(b.reproducibility, '环境等级', 300),
      snapshot: '',
      createdAt: new Date().toISOString(),
      closed: false,
      turns: [],
      automationMode: 'codex',
    };
    if (b.autoStart === true)
      task.turns.push({
        roundNumber: 1,
        id: crypto.randomUUID(),
        prompt: task.title,
        category: task.category,
        difficulty: task.difficulty,
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
    if (task.turns[0]) task.turns[0].questionRootId = task.turns[0].id;
    if (!task.repoPath.startsWith('/'))
      throw new Error('仓库路径需为本机绝对路径');
    await ensureProjectNames();
    await db()
      .prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)')
      .bind(task.id, JSON.stringify(task), task.createdAt)
      .run();
    return Response.json({ task: (await get(task.id))!.task }, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
