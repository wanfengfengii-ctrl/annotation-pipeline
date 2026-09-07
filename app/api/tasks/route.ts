import { all, db, failure, protect, text } from '@/db/store';
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
    const task: Task = {
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
        id: crypto.randomUUID(),
        prompt: task.title,
        category: task.category,
        difficulty: task.difficulty,
        status: 'queued',
        createdAt: new Date().toISOString(),
      });
    if (!task.repoPath.startsWith('/'))
      throw new Error('仓库路径需为本机绝对路径');
    await db()
      .prepare('INSERT INTO tasks(id,data,created_at) VALUES(?,?,?)')
      .bind(task.id, JSON.stringify(task), task.createdAt)
      .run();
    return Response.json({ task }, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
