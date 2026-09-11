'use client';
import {
  canAddTurn,
  claudeCallCount,
  canRepair,
  projectCounts,
  freshCategories,
} from '@/lib/project-series.mjs';
import { RecordsTable } from '@/components/pipeline/records-table';
import {
  sentProjectCounts,
  validationRetryAllowed,
  historicalValidationRetryAllowed,
} from '@/lib/project-recovery.mjs';
import { formatQuestionText } from '@/lib/question-text.mjs';
import { canPlanDisputedTurn } from '@/lib/disputed-continuation.mjs';
import { initialCodeURL, recordRound, recordStack } from '@/lib/record-fields';
import { roundNumber } from '@/lib/record-metadata';
import { RecordMetadataPanel } from '@/components/pipeline/record-metadata-panel';
import { rules, difficultyRules } from '@/lib/task-policy.mjs';
import { HumanReviewPanel } from '@/components/pipeline/human-review-panel';
import { humanLabel, humanIssues } from '@/lib/human-review';
import { SchedulerPanel } from '@/components/pipeline/scheduler-panel';
import { useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  Workflow,
  Plus,
  Layers,
  ClipboardCheck,
  PackageCheck,
  Clock3,
  ShieldCheck,
  FolderPlus,
  Download,
  ArrowUpRight,
  RefreshCw,
  Terminal,
  Play,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  AlertCircle,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  categories,
  difficulties,
  dimensions,
  counted,
  pending,
  issues,
  status,
  deadline,
  producedAt,
  businessDate,
  type Task,
  type Turn,
  type Review,
} from '@/lib/pipeline';
type RecordTask = Task & { revision: number };
const fmt = (s: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(s));
function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger aria-label={label} style={{ width: '100%', height: 40 }}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((v) => (
          <SelectItem value={v} key={v}>
            {v}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={'field ' + (wide ? 'wide' : '')}>
      {label}
      {children}
    </label>
  );
}
function Badge({ value }: { value: string }) {
  const color = value.includes('异常')
    ? 'red'
    : value.includes('评分')
      ? 'amber'
      : value.includes('执行') || value.includes('排队')
        ? 'blue'
        : value.includes('结束')
          ? 'gray'
          : '';
  return <span className={'tag ' + color}>{value}</span>;
}
async function request(url: string, body?: unknown, method = 'POST') {
  const res = await fetch(
    url,
    body
      ? {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store' },
  );
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
const emptyTask = {
  projectSeries: true,
  title: '',
  repoPath: '',
  stack: '',
  category: '0-1 代码生成',
  difficulty: '中等',
  reproducibility: '无外部依赖',
};
export default function Home() {
  const [local, setLocal] = useState(false);
  const [recordsSource, setRecordsSource] = useState<'ai' | 'human'>('ai');
  const [tasks, setTasks] = useState<RecordTask[]>([]),
    [runner, setRunner] = useState<any>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState(emptyTask),
    [selected, setSelected] = useState<string | null>(null),
    [page, setPage] = useState('tasks'),
    [query, setQuery] = useState(''),
    [projectId, setProjectId] = useState(''),
    [filter, setFilter] = useState('全部状态');
  const reload = useCallback(async () => {
    try {
      const d = await request('/api/tasks');
      setTasks(d.tasks);
      setRunner(d.runner);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLocal(['localhost', '127.0.0.1'].includes(window.location.hostname));
    void reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
  }, [reload]);
  useEffect(() => {
    const context = (document as any).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'open_task_creation',
          title: '打开新建标注任务表单',
          description: '打开任务创建表单，不创建任务、不执行模型。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute(input: unknown) {
            if (
              !input ||
              typeof input !== 'object' ||
              Object.keys(input).length
            )
              throw new Error('输入必须是空对象');
            setOpen(true);
            return { opened: true };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, []);
  const active = tasks.find((t) => t.id === selected),
    turns = tasks.flatMap((t) => t.turns.map((r) => ({ t, r }))),
    ready = turns.filter(
      ({ t, r }) => r.status === 'review' && !issues(t, r).length,
    ),
    review = turns.filter(({ r }) => r.status === 'review' && !r.excluded),
    awaiting = turns.filter(
      ({ r }) => !r.excluded && ['review', 'failed'].includes(r.status),
    ),
    online =
      runner && Date.now() - new Date(runner.heartbeat).getTime() < 30000;
  const mutate = async (t: RecordTask, body: object) => {
    if ('humanAction' in body) {
      const { humanAction, ...rest } = body;
      await request('/api/tasks/' + t.id + '/human-review', {
        ...rest,
        action: humanAction,
        revision: t.revision,
      });
      await reload();
      return;
    }
    await request(
      '/api/tasks/' + t.id,
      { ...body, revision: t.revision },
      'PATCH',
    );
    await reload();
  };
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await request('/api/tasks', { ...draft, autoStart: true });
      setOpen(false);
      setDraft(emptyTask);
      await reload();
      setSelected(d.task.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = tasks.filter(
    (t) =>
      (!projectId || t.id === projectId) &&
      (!query ||
        `${t.projectName || ''} ${t.title} ${t.stack} ${t.repoPath}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === '全部状态' || status(t) === filter),
  );
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Workflow className="brand-mark" size={40} />
          标注流水线{' '}
          <span className="tag workspace-label">
            {local ? '本机工作台' : '云端工作台'}
          </span>
        </div>
        <div className="actions">
          <span className="top-note">Codex 编排 · Claude 执行</span>
          <span className={'tag ' + (online ? '' : 'gray')}>
            {online ? '● 执行器在线' : '○ 执行器离线'}
          </span>
        </div>
      </header>
      <main className="shell">
        <div className="pagehead">
          <div>
            <p className="eyebrow">ANNOTATION OPERATIONS / 2026.09</p>
            <h1>作业工作台</h1>
            <p className="sub">从真实工程任务，到可追溯的逐轮交付。</p>
          </div>
          <div className="actions">
            <Button
              variant="outline"
              onClick={() => {
                setRecordsSource('ai');
                setPage('records');
                requestAnimationFrame(() =>
                  document
                    .getElementById('workbench')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                );
              }}
            >
              <Download />
              标注数据 / 导出 Excel
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus />
              新建任务
            </Button>
          </div>
        </div>
        {!local && (
          <div className="issue">
            云端独立工作台 · 尚未连接本机执行器。使用已配置的 Claude CLI，请打开{' '}
            <a href="http://localhost:3000/" className="row-title">
              本机工作台 ↗
            </a>
            。两端数据分别保存。
          </div>
        )}
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <Button variant="ghost" onClick={reload}>
              重新加载
            </Button>
          </div>
        )}
        <SchedulerPanel runner={runner} local={local} />
        <div className="stats">
          {[
            {
              label: '任务总数',
              num: tasks.length,
              note: `${tasks.filter(pending).length} 个任务排队或执行中`,
              icon: Layers,
            },
            {
              label: '待评分或校验',
              num: review.filter(({ t, r }) => issues(t, r).length).length,
              note: '每轮五个维度，独立评价',
              icon: ClipboardCheck,
            },
            {
              label: '可导出轮次',
              num: ready.length,
              note: '字段完整，等待实际提交',
              icon: PackageCheck,
            },
            {
              label: '待提交轮次',
              num: awaiting.length,
              note: `${awaiting.filter(({ r }) => Date.now() > new Date(deadline(producedAt(r))).getTime()).length} 轮已过截止时间`,
              icon: Clock3,
            },
          ].map(({ label, num, note, icon: Icon }) => (
            <div className="stat" key={label}>
              <div className="label">
                {label}
                <Icon size={18} />
              </div>
              <div className="num">{num.toString().padStart(2, '0')}</div>
              <p className="sub">{note}</p>
            </div>
          ))}
        </div>
        <div className="flow">
          {[
            ['任务准备 · Codex', '准备项目骨架、任务与验收条件'],
            ['环境快照 · Codex + gh', '核验镜像、初始代码与参考提交'],
            ['终端执行', '初始题 + 最多两次修复'],
            ['独立验收与评分 · Codex', '读代码、运行复现并依据证据评分'],
            ['校验与交付 · Codex', '生成带 AI 来源的交付包'],
          ].map(([title, desc], i) => (
            <div className="flow-step" key={title}>
              <span className="flow-num">0{i + 1} /</span>
              <strong>{title}</strong>
              <p className="sub">{desc}</p>
            </div>
          ))}
        </div>
        <Tabs
          id="workbench"
          value={page}
          onValueChange={(v) => setPage(String(v))}
        >
          <TabsList variant="line" className="tabbar">
            <TabsTrigger value="tasks">任务工作台</TabsTrigger>
            <TabsTrigger value="records">标注数据</TabsTrigger>
            <TabsTrigger value="human">人工二次确认</TabsTrigger>
            <TabsTrigger value="delivery">
              交付队列 <span className="tag gray">{ready.length}</span>
            </TabsTrigger>
            <TabsTrigger value="rules">流程与规则</TabsTrigger>
          </TabsList>
          <TabsContent value="tasks">
            <section className="panel">
              <div className="panelhead">
                <h2>
                  作业队列{' '}
                  <span className="tag gray">{tasks.length} 个任务</span>
                </h2>
                <div className="actions">
                  <label className="field">
                    <span className="sr-only">搜索任务</span>
                    <input
                      placeholder="搜索任务 / 技术栈"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    项目名称
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                    >
                      <option value="">全部项目</option>
                      {tasks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.projectName || t.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div style={{ minWidth: 130 }}>
                    <Picker
                      value={filter}
                      onChange={setFilter}
                      label="任务状态"
                      options={[
                        '全部状态',
                        '待开始',
                        '排队中',
                        '执行中',
                        '待评分或校验',
                        '待提交',
                        '执行异常',
                        '可继续交互',
                        '已结束',
                      ]}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="刷新"
                    onClick={reload}
                  >
                    <RefreshCw size={16} />
                  </Button>
                </div>
              </div>
              {loading ? (
                <div className="blank" role="status">
                  正在读取任务…
                </div>
              ) : !filtered.length ? (
                <div className="blank">
                  <div className="blank-icon">
                    <FolderPlus size={30} />
                  </div>
                  <h2>
                    {tasks.length ? '没有匹配的任务' : '创建第一个标注任务'}
                  </h2>
                  <p className="sub">
                    {tasks.length
                      ? '调整搜索或状态筛选。'
                      : '填写仓库路径和任务目标，Codex 准备任务并检查环境，Claude 执行后由 Codex 评分和打包。'}
                  </p>
                  {!tasks.length && (
                    <Button onClick={() => setOpen(true)}>
                      新建任务
                      <ArrowUpRight />
                    </Button>
                  )}
                </div>
              ) : (
                <Table className="data-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>任务 / 技术栈</TableHead>
                      <TableHead>当前状态</TableHead>
                      <TableHead>轮次</TableHead>
                      <TableHead>初始快照</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell>
                          <button
                            className="row-title"
                            onClick={() => setSelected(t.id)}
                          >
                            {t.projectName || t.title}
                          </button>
                          <div className="sub">
                            {t.title} · {t.category} · {recordStack(t.stack)} ·{' '}
                            {t.difficulty}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge value={status(t)} />
                        </TableCell>
                        <TableCell>
                          <div style={{ width: 150 }}>
                            {['0-1 代码生成', 'Feature 迭代'].map((c) => (
                              <div className="sub" key={c}>
                                {c} 已发送 {sentProjectCounts(t)[c]} / 10
                                {projectCounts(t)[c] >
                                  sentProjectCounts(t)[c] &&
                                  ` · 预留 ${projectCounts(t)[c] - sentProjectCounts(t)[c]}`}
                              </div>
                            ))}
                            <div className="sub">
                              已记录 {counted(t)} 条对话
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {initialCodeURL(t) ? (
                            <a
                              href={initialCodeURL(t)}
                              target="_blank"
                              rel="noreferrer"
                              className="tag"
                            >
                              <GitBranch
                                size={12}
                                style={{ display: 'inline' }}
                              />{' '}
                              {initialCodeURL(t).slice(-40, -32)}
                            </a>
                          ) : (
                            <span className="sub">首轮执行前采集</span>
                          )}
                        </TableCell>
                        <TableCell className="sub">
                          {fmt(t.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            onClick={() => setSelected(t.id)}
                          >
                            打开
                            <ChevronRight />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </TabsContent>
          <TabsContent value="records">
            <RecordsTable
              projects={tasks.map((t) => ({
                id: t.id,
                name: t.projectName || t.title,
              }))}
              key={recordsSource}
              source={recordsSource}
              onOpen={setSelected}
            />
          </TabsContent>
          <TabsContent value="human">
            <section className="panel">
              <div className="panelhead">
                <h2>AI 评分后的人工确认</h2>
                <Button
                  variant="outline"
                  onClick={() => {
                    setRecordsSource('human');
                    setPage('records');
                  }}
                >
                  筛选并导出已确认轮次
                </Button>
              </div>
              <p className="sub" style={{ padding: '0 24px' }}>
                自动执行、评分和续跑照常进行。按轮次检查产物与 AI
                评价，记录最终人工确认。
              </p>
              {!turns.some(
                ({ r }) =>
                  r.review?.source === 'codex' &&
                  !r.excluded &&
                  ['review', 'submitted'].includes(r.status),
              ) ? (
                <div className="blank">
                  <h2>AI 评分完成后，轮次会出现在这里</h2>
                </div>
              ) : (
                <Table className="data-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>任务 / 轮次</TableHead>
                      <TableHead>人工确认状态</TableHead>
                      <TableHead>待核对</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {turns
                      .filter(
                        ({ r }) =>
                          r.review?.source === 'codex' &&
                          !r.excluded &&
                          ['review', 'submitted'].includes(r.status),
                      )
                      .map(({ t, r }) => (
                        <TableRow key={r.id}>
                          <TableCell>
                            {t.projectName || t.title}
                            <p className="sub">
                              {recordRound(roundNumber(t, r))} · {r.category}
                            </p>
                          </TableCell>
                          <TableCell>{humanLabel(r)}</TableCell>
                          <TableCell>{humanIssues(t, r).length} 项</TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              onClick={() => setSelected(t.id)}
                            >
                              打开确认
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </TabsContent>
          <TabsContent value="delivery">
            <section className="panel">
              <div className="panelhead">
                <h2>逐轮交付</h2>
                <span className="sub">导出不会自动标记提交 · 北京时间</span>
              </div>
              {!turns.length ? (
                <div className="blank">
                  <PackageCheck className="blank-icon" size={54} />
                  <h2>交互完成后，在这里核对交付</h2>
                </div>
              ) : (
                <Table className="data-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>任务 / 轮次</TableHead>
                      <TableHead>形式校验</TableHead>
                      <TableHead>截止时间</TableHead>
                      <TableHead>提交状态</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {turns.map(({ t, r }) => (
                      <TableRow key={r.id}>
                        <TableCell>
                          <span className="row-title">
                            {t.projectName || t.title}
                          </span>
                          <div className="sub">
                            第 {t.turns.indexOf(r) + 1} 次交互 · {r.category}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            value={
                              r.excluded
                                ? '工程故障已排除'
                                : issues(t, r).length
                                  ? `待补充 ${issues(t, r).length} 项`
                                  : '形式校验通过'
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              Date.now() >
                                new Date(deadline(producedAt(r))).getTime() &&
                              r.status !== 'submitted'
                                ? 'tag red'
                                : 'sub'
                            }
                          >
                            {fmt(deadline(producedAt(r)))}
                          </span>
                        </TableCell>
                        <TableCell>
                          {r.status === 'submitted' ? (
                            <span className="tag">已登记提交</span>
                          ) : (
                            <span className="sub">未提交</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            onClick={() => setSelected(t.id)}
                          >
                            核对
                            <ChevronRight />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </TabsContent>
          <TabsContent value="rules">
            <div className="rules">
              <div className="rulebox">
                <h2>执行方式</h2>
                <p>
                  Claude 在 Mac Terminal
                  的独立容器中执行，沿用已配置的模型、网关和 1,000,000
                  上下文。每道独立题开启新会话，Bug 修复最多在原会话追问两次。
                </p>
                <p>
                  执行器：{online ? '在线' : '离线'} ·{' '}
                  {runner?.version || '尚未连接'}
                </p>
                <p>
                  本机启动：<code>npm run runner</code>
                  。云端页面需要另行连接可认证的执行器；不会从浏览器直接执行本机命令。
                </p>
              </div>
              <div className="rulebox">
                <h2>逐轮验收</h2>
                <ul>
                  <li>
                    每个 Prompt-response pair 为一条数据；同项目 0-1 与 Feature
                    各最多十题，每会话最多两道 Bug 修复，含 504
                    继续最多十次调用。
                  </li>
                  <li>
                    Bug
                    修复说明具体问题，最多追问两次；失败调用仍占十次调用上限。
                  </li>
                  <li>仅工程故障、网络波动导致无反馈价值的轮次可人工排除。</li>
                  <li>
                    Codex
                    自动填写五项评分及证据；内部校验通过不等于原项目人工质检通过。
                  </li>
                </ul>
              </div>
              <div className="rulebox">
                <h2>题目与每日分布</h2>
                <p>
                  首轮不允许简单题。0–1 代码生成 / Feature 迭代 / Bug 修复 ＞
                  代码理解 ≈ 代码重构 ＞ 其他。文档未规定各类别的精确比例。
                </p>
                {categories.map((c) => (
                  <p key={c}>
                    {c}：
                    {
                      turns.filter(
                        ({ r }) =>
                          !r.excluded &&
                          r.category === c &&
                          Boolean(r.finishedAt) &&
                          businessDate(producedAt(r)) ===
                            businessDate(new Date().toISOString()),
                      ).length
                    }{' '}
                    轮（今日）
                  </p>
                ))}
                <p>
                  禁出规则 {rules.version}
                  ：自动出题后独立审核，准备后的任务再次审核；不通过则拦截。覆盖换皮变体，并对最近
                  200 个跨仓库任务做语义查重。语义判断仍可能误判。
                </p>
                <ul>
                  {rules.general.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <details>
                  <summary>难度规则：四项命中至少两项则拒绝</summary>
                  <p>
                    首轮禁止简单题；后续已有产物的小 Bug
                    修复可使用简单修复例外，必须有前序产物证据。不设量化难度上限。
                  </p>
                  <ul>
                    {difficultyRules.features.map((f) => (
                      <li key={f.id}>
                        {f.name}：{f.description}
                      </li>
                    ))}
                  </ul>
                  <ul>
                    {difficultyRules.levels.map((l) => (
                      <li key={l.name}>
                        {l.name}：{l.definition}
                      </li>
                    ))}
                  </ul>
                </details>
                {rules.groups.map((g) => (
                  <details key={g.id}>
                    <summary>{g.name}</summary>
                    <ul>
                      {g.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
              <div className="rulebox">
                <h2>提交约束</h2>
                <ul>
                  <li>20:00 前产生的数据当天提交，之后的次日 14:00 前提交。</li>
                  <li>初始快照使用完整 SHA；远端访问权限需人工确认。</li>
                  <li>
                    当前为 AI 评测模式，不符合原文档的人工标注要求，导出明确标记
                    AI 来源。
                  </li>
                  <li>已提交轮次锁定，保留外部提交记录；不提供返修入口。</li>
                </ul>
                <a
                  className="row-title"
                  href="https://docs.qq.com/document/DVUhTYVdrZkFxdEhy"
                  target="_blank"
                  rel="noreferrer"
                >
                  查看原始作业规范 ↗
                </a>
              </div>
            </div>
          </TabsContent>
        </Tabs>
        <p className="footer-note">
          <ShieldCheck size={18} />
          AI 自动评测：Codex 负责准备、快照检查、评分和交付；Claude
          负责执行。导出保留 AI 来源。
        </p>
      </main>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="modal"
          style={{ maxWidth: 'min(640px, calc(100% - 32px))' }}
        >
          <DialogTitle>新建标注任务</DialogTitle>
          <DialogDescription>
            独立题目新建会话，Bug
            修复沿用原会话，最多追问两次。执行前请确认仓库提交已推送，且评测团队可以访问。
          </DialogDescription>
          <form onSubmit={create} className="formgrid">
            <label className="human-check wide">
              <input
                type="checkbox"
                checked={draft.projectSeries}
                onChange={(e) =>
                  setDraft({ ...draft, projectSeries: e.target.checked })
                }
              />
              项目连续出题：0–1 创建后，在同一项目迭代、修复与分析
            </label>
            <Field label="任务名称" wide>
              <input
                required
                maxLength={200}
                placeholder="例如：为现有解析器补充增量解析能力"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </Field>
            <Field label="本机 Git 仓库绝对路径" wide>
              <input
                required
                placeholder="/Users/你的用户名/projects/repository"
                value={draft.repoPath}
                onChange={(e) =>
                  setDraft({ ...draft, repoPath: e.target.value })
                }
              />
            </Field>
            <div className="wide sub">
              题型、难度、技术栈和验收条件由 Codex
              自动准备。创建后会立即排队，分别调用本机配置的 Codex CLI 和 Claude
              CLI。
            </div>
            <div className="wide sub">
              执行器会创建独立工作区，在每道独立题开始前将冻结的初始代码发布到本项目的私有
              GitHub 快照仓库。
            </div>
            <div className="wide actions">
              <Button type="submit" disabled={busy}>
                {busy ? '正在创建…' : '创建并启动流水线'}
              </Button>
              {error && (
                <span role="alert" className="sub">
                  {error}
                </span>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Sheet
        open={Boolean(active)}
        onOpenChange={(v) => !v && setSelected(null)}
      >
        <SheetContent
          style={{ width: 'min(100%, 920px)', maxWidth: 920, overflow: 'auto' }}
        >
          {active && (
            <TaskDetail
              key={active.id}
              task={active}
              online={online}
              mutate={mutate}
              initialTab={page === 'human' ? 'human' : 'turns'}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
function TaskDetail({
  task: t,
  online,
  mutate,
  initialTab,
}: {
  task: RecordTask;
  initialTab: string;
  online: boolean;
  mutate: (t: RecordTask, b: object) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(''),
    [category, setCategory] = useState(
      t.turns.length ? 'Feature 迭代' : t.category,
    ),
    [difficulty, setDifficulty] = useState(t.difficulty),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState(initialTab);
  const nextCategories =
    t.projectSeries && !t.turns.length
      ? ['0-1 代码生成']
      : [
          ...freshCategories.filter((c) => canAddTurn(t, c)),
          ...(canRepair(t, t.turns.at(-1)) ? ['Bug 修复'] : []),
        ];
  const selectedCategory = nextCategories.includes(category)
    ? category
    : nextCategories[0] || category;
  async function run(body: object) {
    setBusy(true);
    setError('');
    try {
      await mutate(t, body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="detail">
      <p className="eyebrow">TASK / {t.id.slice(0, 8)}</p>
      <SheetTitle style={{ fontSize: 24, marginTop: 12, marginRight: 30 }}>
        {t.projectName || t.title}
      </SheetTitle>
      <SheetDescription className="sub">
        {t.title} · {recordStack(t.stack)} · {t.category} · {t.difficulty}
      </SheetDescription>
      <div className="actions" style={{ margin: '16px 0' }}>
        <Badge value={status(t)} />
        <span className="tag gray">
          已发送：0-1 {sentProjectCounts(t)['0-1 代码生成']} / 10 · Feature{' '}
          {sentProjectCounts(t)['Feature 迭代']} / 10 · 已记录 {counted(t)}{' '}
          条对话 · 总调用 {claudeCallCount(t)}
        </span>
        {t.projectSeries && <span className="tag">同一项目连续出题</span>}
        <span className="sub">{t.model || '模型沿用 Claude CLI 配置'}</span>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList className="tabbar detail-tabbar">
          <TabsTrigger value="turns">交互与自动评分</TabsTrigger>
          <TabsTrigger value="human">人工二次确认</TabsTrigger>
          <TabsTrigger value="environment">环境与快照</TabsTrigger>
        </TabsList>
        <TabsContent value="turns">
          {!t.turns.length && (
            <div className="section">
              <h3>输入任务目标</h3>
              <p className="sub">
                填写目标和约束，原始目标与 Codex 生成的执行 Prompt 分别保存。
              </p>
            </div>
          )}
          {t.turns.map((r, i) => (
            <TurnPanel
              key={r.id}
              task={t}
              turn={r}
              index={i}
              run={run}
              busy={busy}
            />
          ))}
          {!t.closed &&
            (canAddTurn(t) || canRepair(t, t.turns.at(-1))) &&
            !pending(t) && (
              <form
                className="section formgrid"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    await run({
                      action: 'enqueue',
                      prompt,
                      category: selectedCategory,
                      difficulty,
                    })
                  ) {
                    setPrompt('');
                  }
                }}
              >
                <h3 className="wide">
                  {t.turns.length ? '追加下一轮交互' : '本轮任务目标'}
                </h3>
                <Field label="本轮任务类型">
                  <Picker
                    label="本轮任务类型"
                    value={selectedCategory}
                    options={nextCategories}
                    onChange={setCategory}
                  />
                </Field>
                <Field label="本轮难度">
                  <Picker
                    label="本轮难度"
                    value={difficulty}
                    options={
                      counted(t)
                        ? difficulties
                        : difficulties.filter((d) => d !== '简单')
                    }
                    onChange={setDifficulty}
                  />
                </Field>
                <Field label="执行 Prompt" wide>
                  <textarea
                    required
                    maxLength={80000}
                    style={{ minHeight: 140 }}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="填写具体目标。全新功能选 0-1，改进已有功能选 Feature；Bug 修复说明当前结果的问题和预期，最多追问两次。"
                  />
                </Field>
                {!online && (
                  <p className="wide issue">
                    本机执行器尚未在线。任务可以排队，连接后会按顺序执行。
                  </p>
                )}
                <div className="wide">
                  <Button disabled={busy} type="submit">
                    <Play />
                    {online ? '加入队列并执行' : '加入等待队列'}
                  </Button>
                </div>
              </form>
            )}
          {pending(t) && (
            <div className="issue" style={{ marginTop: 20 }}>
              任务已进入执行队列，状态每 5 秒刷新。Claude 完成后自动进入 Codex
              评分与交付校验。
            </div>
          )}
          {!canAddTurn(t) && (
            <div className="issue">
              本项目的 0-1 与 Feature
              题额已用完。当前会话仍可在两次修复额度内处理具体 Bug。
            </div>
          )}
          {!t.closed && !pending(t) && (
            <Button
              style={{ marginTop: 20 }}
              variant="outline"
              disabled={busy}
              onClick={() => run({ action: 'close' })}
            >
              结束此项目
            </Button>
          )}
        </TabsContent>
        <TabsContent value="human">
          {t.turns
            .filter(
              (r) =>
                r.review?.source === 'codex' &&
                !r.excluded &&
                ['review', 'submitted'].includes(r.status),
            )
            .map((r) => (
              <div key={r.id}>
                <h3 className="section">
                  {recordRound(roundNumber(t, r))} · {r.category}
                </h3>
                <HumanReviewPanel
                  key={r.id}
                  task={t}
                  turn={r}
                  busy={busy}
                  run={run}
                />
              </div>
            ))}
          {!t.turns.some(
            (r) =>
              r.review?.source === 'codex' &&
              !r.excluded &&
              ['review', 'submitted'].includes(r.status),
          ) && (
            <p className="sub section">
              本会话暂未产生 AI 评分。流水线会自动执行，完成后可在这里核验。
            </p>
          )}
        </TabsContent>
        <TabsContent value="environment">
          <div className="section">
            <h3>初始环境快照</h3>
            {Object.values(t.initialCodeSnapshots || {}).map((snapshot, i) => (
              <p key={snapshot.questionId} className="sub mono">
                原题 {i + 1}：
                <a href={snapshot.url} target="_blank" rel="noreferrer">
                  {snapshot.url}
                </a>
              </p>
            ))}
            {!Object.keys(t.initialCodeSnapshots || {}).length &&
            initialCodeURL(t) ? (
              <a
                href={initialCodeURL(t)}
                target="_blank"
                rel="noreferrer"
                className="sub mono"
              >
                {initialCodeURL(t)}
              </a>
            ) : !Object.keys(t.initialCodeSnapshots || {}).length ? (
              <p className="sub">
                执行前将冻结的初始代码发布至 GitHub，并核验完整 Commit 链接。
              </p>
            ) : null}
          </div>
          {[
            ['容器镜像快照', t.snapshot || '尚未采集'],
            ['宿主机参考仓库', t.repoPath],
            ['独立工作区', t.workDir || '尚未创建'],
            ['容器名称', t.container?.name || '尚未创建'],
            [
              '容器状态',
              t.container
                ? {
                    running: '运行中',
                    stopped: '已停止，待导出',
                    exported: '已核验，待清理',
                    removed: '已归档并删除',
                    error: '需处理',
                  }[t.container.status]
                : '尚未创建',
            ],
            [
              '完整轨迹目录',
              t.container?.traceExport?.path || '每轮完成后自动导出',
            ],
            ['容器处理信息', t.container?.error || '正常'],
            ['GitHub 参考快照', t.githubSnapshot?.url || '未记录'],
            ['Harness', t.harnessVersion || '首轮运行后记录'],
            ['实际模型', t.model || '运行后从 CLI 初始化事件读取'],
            ['操作系统', t.os || '执行后记录'],
            ['环境可复现等级', t.reproducibility],
            ['SessionID', t.sessionId || '尚未开始'],
          ].map(([label, value]) => (
            <div className="section" key={label}>
              <h3>{label}</h3>
              <p className="sub mono">{value}</p>
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
function TurnPanel({
  task: t,
  turn: r,
  index,
  run,
  busy,
}: {
  task: RecordTask;
  turn: Turn;
  index: number;
  run: (body: object) => Promise<boolean>;
  busy: boolean;
}) {
  const blank: Review = {
    scores: [0, 0, 0, 0, 0],
    descriptions: ['', '', '', '', ''],
    reviewer: '',
    attested: false,
    other: '',
  };
  const [review, setReview] = useState<Review>(r.review || blank),
    [receipt, setReceipt] = useState(''),
    [submitter, setSubmitter] = useState(''),
    [reason, setReason] = useState(''),
    [promptId, setPromptId] = useState(r.promptId || ''),
    [tracePath, setTracePath] = useState(r.tracePath || '');
  const labels = {
    queued: '排队中',
    running: '执行中',
    review: '待评分或校验',
    failed: '执行异常',
    submitted: '已提交',
  };
  return (
    <section className="section">
      <div
        className="actions"
        style={{ justifyContent: 'space-between', marginBottom: 12 }}
      >
        <h3>
          第 {index + 1} 次交互{' '}
          <span className="tag gray">
            {r.category} · {r.difficulty}
          </span>
        </h3>
        <Badge
          value={
            r.projectRetry
              ? '同项目续题中'
              : r.projectRecovery?.state === 'continued' &&
                  r.status === 'failed'
                ? '历史失败·已续题'
                : r.excluded
                  ? '工程故障已排除'
                  : labels[r.status]
          }
        />
      </div>
      <p className="sub">
        {fmt(producedAt(r))} · 截止 {fmt(deadline(producedAt(r)))}
      </p>
      <details style={{ marginTop: 12 }}>
        <summary className="row-title">执行 Prompt</summary>
        <pre className="sub" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>
          {formatQuestionText(r.prompt)}
        </pre>
      </details>
      {r.output && (
        <details style={{ marginTop: 12 }}>
          <summary className="row-title">模型原始回复</summary>
          <pre
            className="sub"
            style={{
              whiteSpace: 'pre-wrap',
              marginTop: 10,
              maxHeight: 400,
              overflow: 'auto',
            }}
          >
            {r.output}
          </pre>
        </details>
      )}
      {t.automationNotice && (
        <output className="sub">自动流程：{t.automationNotice}</output>
      )}
      {t.automationMode && (
        <section className="section">
          <h3>
            当前阶段：
            {(
              {
                context: '上下文配置预检',
                scaffold: 'Codex 项目骨架',
                prepare: 'Codex 任务准备',
                policy: 'Codex 禁出、雷同与难度审核',
                snapshot: 'Codex 容器环境检查与 GitHub 参考快照',
                claude: 'Claude 执行',
                'runtime-plan': 'Codex 阅读代码并制定复现计划',
                'runtime-running': '独立容器运行验收与复现',
                'runtime-diagnose': 'Codex 核对实际复现结果',
                score: 'Codex 五维评分',
                delivery: 'Codex 校验与交付',
              } as Record<string, string>
            )[r.stage || 'prepare'] || r.stage}
          </h3>
          {r.requestedPrompt && (
            <details>
              <summary>原始任务目标</summary>
              <p className="sub">{r.requestedPrompt}</p>
            </details>
          )}
          {r.automation &&
            Object.entries(r.automation)
              .filter(([, v]) => v && typeof v === 'object' && 'tracePath' in v)
              .map(([k, v]) => (
                <details key={k}>
                  <summary className="sub">{k} · Codex 阶段记录</summary>
                  <pre className="sub mono" style={{ whiteSpace: 'pre-wrap' }}>
                    {JSON.stringify(v, null, 2)}
                  </pre>
                </details>
              ))}
          {r.automation?.policy && (
            <p className="sub">
              禁出审核：
              {r.automation.policy.accepted === true
                ? '通过'
                : r.automation.policy.accepted === false ||
                    !r.automation.policy.value.allowed
                  ? '已拦截'
                  : '历史审核（需按新版复核）'}{' '}
              ·{' '}
              {r.automation.policy.rejection ||
                r.automation.policy.value.reason}
            </p>
          )}
          {r.automation?.policy?.value?.difficultyEvidence && (
            <div className="rulebox">
              <h3>
                独立难度评估：{r.automation.policy.value.assessedDifficulty}
              </h3>
              <p className="sub">
                过于简单特征：{r.automation.policy.value.simpleFeatures.length}{' '}
                / 4 项。
                {r.automation.policy.value.followupFix
                  ? '本轮申请后续产物小 Bug 修复例外。'
                  : ''}
              </p>
              <ul>
                {difficultyRules.features.map((f, i) => (
                  <li key={f.id}>
                    {f.name} ·{' '}
                    {r.automation!.policy.value.simpleFeatures.includes(f.id)
                      ? '命中'
                      : '未命中'}
                    ：{r.automation!.policy.value.difficultyEvidence[i]}
                  </li>
                ))}
              </ul>
              <p className="sub">{r.automation.policy.value.followupReason}</p>
            </div>
          )}
          {t.githubSnapshot && (
            <p className="sub">
              GitHub CLI 已核验 · {t.githubSnapshot.repository} ·{' '}
              {t.githubSnapshot.isPrivate ? '私有仓库' : '公开仓库'} ·{' '}
              {t.githubSnapshot.accessNote}
            </p>
          )}
          {r.automation?.snapshot?.value?.environmentLevel && (
            <p className="sub">
              环境：{r.automation.snapshot.value.environmentLevel} · 启动方式：
              {r.automation.snapshot.value.startup} · 核验：
              {r.automation.snapshot.value.verification}
            </p>
          )}
          {r.automation?.archive && (
            <p className="sub mono">
              本机证据归档：{r.automation.archive.archivePath}
              <br />
              SHA-256：{r.automation.archive.sha256} ·{' '}
              {r.automation.archive.files} 个文件
            </p>
          )}
          {r.automation?.submission && (
            <div className="sub">
              <strong>
                提交副本：
                {r.automation.submission.status === 'passed'
                  ? '完整目录与内容检查通过'
                  : r.automation.submission.status === 'awaiting_finalization'
                    ? '等待本题最终导出'
                    : r.automation.submission.status === 'needs_review'
                      ? '有附件需要人工检查'
                      : '待重新检查'}
              </strong>
              <p>
                原始证据已保留，提交副本单独生成。内容检查覆盖已配置的敏感信息规则。
              </p>
              {r.automation.submission.status === 'passed' && (
                <p className="mono">
                  ZIP：
                  {r.automation.submission.zipArchivePath ||
                    r.automation.submission.archivePath}
                  <br />
                  SHA-256：
                  {r.automation.submission.zipSha256 ||
                    r.automation.submission.sha256}
                </p>
              )}
              {r.automation.submission.reason && (
                <p>{r.automation.submission.reason}</p>
              )}
            </div>
          )}
          {r.automation?.next && (
            <p className="sub">
              下一步：{r.automation.next.value.action} ·{' '}
              {r.automation.next.value.reason}
            </p>
          )}
          {r.automation?.bundlePath && (
            <p className="sub mono">本机交付包：{r.automation.bundlePath}</p>
          )}
        </section>
      )}
      {r.automation?.runtimeVerification && (
        <section className="section">
          <h3>
            独立运行验收 ·{' '}
            {
              (
                {
                  passed: '已执行检查通过',
                  bugs: '已复现业务缺陷',
                  blocked: '验收阻塞',
                } as Record<string, string>
              )[r.automation.runtimeVerification.status]
            }
          </h3>
          <p className="sub">{r.automation.runtimeVerification.summary}</p>
          <p className="sub">
            在隔离代码副本中运行，原始产物和 Claude
            轨迹保持原样。通过仅表示已执行的检查通过。
          </p>
          {r.automation.runtimeVerification.checks.map((c: any) => (
            <details key={c.id} className="section">
              <summary>
                {c.id} ·{' '}
                {
                  (
                    {
                      passed: '通过',
                      reproduced: '已复现',
                      not_reproduced: '未复现',
                      blocked: '阻塞',
                    } as Record<string, string>
                  )[c.outcome]
                }{' '}
                · 退出码 {c.exitCode ?? '未正常退出'}
              </summary>
              <p className="sub">原题要求：{c.requirement}</p>
              <p className="sub">预期：{c.expected}</p>
              <p className="sub">实际：{c.observed}</p>
              <p className="sub mono">代码：{c.codeEvidence}</p>
              <pre className="sub mono">{c.command}</pre>
              <p className="sub mono">
                本机日志：{c.logPath}:{c.evidenceLine}
              </p>
            </details>
          ))}
          <p className="sub mono">
            本机报告：{r.automation.runtimeVerification.reportPath}
          </p>
        </section>
      )}
      {r.review?.source === 'codex' && (
        <section className="section">
          <h3>
            Codex 自动评分 <span className="tag blue">AI 生成</span>
          </h3>
          <div className="reviewgrid">
            {dimensions.map((d, i) => (
              <div className="scorebox" key={d}>
                <h3>
                  {d} · {r.review!.scores[i]} / 5
                </h3>
                <p className="sub">{r.review!.descriptions[i]}</p>
                {r.review!.evidenceRefs?.[i] && (
                  <details className="sub">
                    <summary>查看评分依据</summary>
                    <p>
                      {r.review!.when?.[i]} · {r.review!.behavior?.[i]}
                    </p>
                    <p>{r.review!.impact?.[i]}</p>
                    <p>{r.review!.expected?.[i]}</p>
                    <p className="mono">{r.review!.evidenceRefs[i]}</p>
                  </details>
                )}
              </div>
            ))}
          </div>
          <p className="sub">{r.review.other}</p>
        </section>
      )}
      {r.container && (
        <details className="section">
          <summary>
            本题容器与权限 ·{' '}
            {r.permissionAudit?.passed ? '免审批已核验' : '待核验或存在异常'}
          </summary>
          <p className="sub">
            独立题目使用新 Terminal 会话；Bug 修复最多两轮，504
            后在原会话发送继续，实际调用合计最多十次。
          </p>
          <p className="sub">
            终端：
            {r.container.terminalIdentity?.realTerminal
              ? 'Mac Terminal'
              : '未核验'}{' '}
            · {r.container.terminalIdentity?.tty}
          </p>
          {r.container.scaffoldSnapshot && (
            <p className="sub">
              Codex 已预先准备 {r.container.scaffoldSnapshot.files}{' '}
              个骨架文件，业务功能由 Claude 完成。
            </p>
          )}
          <p className="sub mono">
            {r.container.containerId || r.container.name}
          </p>
          {r.container.sourceSnapshot && (
            <p className="sub">
              已在启动后导入上一题代码快照，共{' '}
              {r.container.sourceSnapshot.files} 个文件；排除{' '}
              {r.container.sourceSnapshot.omitted.length} 项依赖、缓存或配置。
            </p>
          )}
          <p className="sub">
            启动预检：
            {r.container.permissionPreflight?.passed ? '通过' : '未记录'} ·
            原始轨迹权限拒绝：{r.permissionAudit?.denialCount ?? '未核验'} 次
          </p>
          <p className="sub">
            已调用工具：{r.permissionAudit?.tools?.join('、') || '未记录'}
          </p>
          {r.permissionAudit?.findings?.map((f, i) => (
            <p className="issue mono" key={i}>
              {f.tool} · {f.kind} · {f.file}:{f.line}
            </p>
          ))}
        </details>
      )}
      {r.contextCheck && (
        <details className="section">
          <summary>
            本轮上下文检查 ·{' '}
            {r.contextCheck.ready ? '客户端声明符合' : '待核验'}
          </summary>
          <p className="sub">{r.contextCheck.reason}</p>
          <p className="sub">
            模型：{r.contextCheck.model} · 运行报告：
            {r.contextCheck.runtimeTokens ?? '未报告'} tokens
          </p>
          <p className="sub">{r.contextCheck.note}</p>
        </details>
      )}
      {r.error && (
        <p className="issue" style={{ marginTop: 12 }}>
          {r.error}
        </p>
      )}
      <RecordMetadataPanel
        key={r.id + (r.metadataHistory?.length || 0)}
        task={t}
        turn={r}
        run={run}
        busy={busy}
      />
      {r.continuationOf && (
        <details className="section">
          <summary>本轮继续原题 · 原始验收目标</summary>
          <p className="sub">{r.evaluationPrompt}</p>
        </details>
      )}
      {(r.automation?.nextError || canPlanDisputedTurn(t, r)) && (
        <div className="section">
          <p className="issue">
            {r.automation?.submittedPolicyEvidence
              ? '本轮题面异常和评测证据已保留；后续题目单独规划。'
              : '本轮评分和归档已保留。'}
            {r.automation?.nextError &&
              '后续出题失败：' + r.automation.nextError}
          </p>
          {(r.status === 'review' || canPlanDisputedTurn(t, r)) &&
            t.turns.at(-1)?.id === r.id &&
            !r.humanReview &&
            !r.receipt &&
            !t.closed && (
              <Button
                variant="outline"
                disabled={busy || pending(t)}
                onClick={() => run({ action: 'retry-plan', turnId: r.id })}
              >
                仅重试后续出题
              </Button>
            )}
        </div>
      )}
      {r.status === 'failed' &&
        !r.excluded &&
        (t.turns.at(-1)?.id === r.id ||
          historicalValidationRetryAllowed(t, r)) &&
        !canPlanDisputedTurn(t, r) && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run({
                action:
                  validationRetryAllowed(t, r) ||
                  historicalValidationRetryAllowed(t, r)
                    ? 'retry-validation'
                    : 'retry',
                turnId: r.id,
              })
            }
          >
            {validationRetryAllowed(t, r) ||
            historicalValidationRetryAllowed(t, r)
              ? '仅重做验收与评分'
              : '重试失败阶段'}
          </Button>
        )}
      {r.excluded ? (
        <p className="sub">排除原因：{r.excludeReason}</p>
      ) : (
        <>
          {r.status === 'review' &&
            r.review?.source !== 'codex' &&
            !t.automationMode && (
              <details style={{ marginTop: 18 }} open={!r.review}>
                <summary className="row-title">人工评分与反馈</summary>
                <p className="sub" style={{ margin: '12px 0' }}>
                  每项 1–5
                  分。写清具体步骤、行为、证据与影响；同时核对过程和产物。
                </p>
                <div className="reviewgrid">
                  {dimensions.map((d, i) => (
                    <div className="scorebox" key={d}>
                      <Field label={d}>
                        <Picker
                          label={d + '评分'}
                          value={
                            review.scores[i]
                              ? String(review.scores[i])
                              : '未评分'
                          }
                          options={['未评分', '1', '2', '3', '4', '5']}
                          onChange={(v) =>
                            setReview({
                              ...review,
                              scores: review.scores.map((s, j) =>
                                j === i ? Number(v) || 0 : s,
                              ),
                            })
                          }
                        />
                        <textarea
                          style={{ marginTop: 10 }}
                          placeholder="人工填写具体依据"
                          value={review.descriptions[i]}
                          onChange={(e) =>
                            setReview({
                              ...review,
                              descriptions: review.descriptions.map((s, j) =>
                                j === i ? e.target.value : s,
                              ),
                            })
                          }
                        />
                      </Field>
                    </div>
                  ))}
                </div>
                <div className="formgrid" style={{ marginTop: 16 }}>
                  <Field label="评分人">
                    <input
                      value={review.reviewer}
                      onChange={(e) =>
                        setReview({ ...review, reviewer: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="其他问题">
                    <input
                      value={review.other}
                      onChange={(e) =>
                        setReview({ ...review, other: e.target.value })
                      }
                    />
                  </Field>
                  <label className="wide actions sub">
                    <Checkbox
                      checked={review.attested}
                      onCheckedChange={(v) =>
                        setReview({ ...review, attested: Boolean(v) })
                      }
                    />
                    我已人工检查过程和产物，并独立填写评分与依据。
                  </label>
                  <div className="wide">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run({ action: 'review', turnId: r.id, review })
                      }
                    >
                      保存人工评分
                    </Button>
                  </div>
                </div>
              </details>
            )}
          {['review', 'failed', 'submitted'].includes(r.status) && (
            <details style={{ marginTop: 16 }}>
              <summary className="row-title">
                轨迹与校验{' '}
                {r.status === 'review' && `· ${issues(t, r).length} 项待完善`}
              </summary>
              <p className="sub mono">SessionID：{r.sessionId || '未捕获'}</p>
              <p className="sub mono">
                PromptID：{r.promptId || '未捕获，请从原始轨迹核对补录'}
              </p>
              <p className="sub mono">轨迹文件：{r.tracePath || '未记录'}</p>
              {issues(t, r).map((e) => (
                <p className="sub" key={e}>
                  • {e}
                </p>
              ))}
              {r.status !== 'submitted' &&
                !r.review &&
                !r.automation?.archive && (
                  <div className="formgrid" style={{ marginTop: 12 }}>
                    <Field label="原始用户消息 PromptID">
                      <input
                        value={promptId}
                        onChange={(e) => setPromptId(e.target.value)}
                      />
                    </Field>
                    <Field label="原始轨迹文件位置">
                      <input
                        value={tracePath}
                        onChange={(e) => setTracePath(e.target.value)}
                      />
                    </Field>
                    <div className="wide">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          run({
                            action: 'trace',
                            turnId: r.id,
                            promptId,
                            tracePath,
                          })
                        }
                      >
                        保存人工核对的定位信息
                      </Button>
                    </div>
                  </div>
                )}
            </details>
          )}
          {r.status === 'review' && !issues(t, r).length && (
            <div style={{ marginTop: 18 }}>
              <p className="tag">字段形式校验通过</p>
              <div className="formgrid" style={{ marginTop: 12 }}>
                <Field label="实际提交人" wide>
                  <input
                    maxLength={100}
                    value={submitter}
                    onChange={(e) => setSubmitter(e.target.value)}
                  />
                </Field>
                <Field label="实际提交记录 / 外部回执" wide>
                  <input
                    value={receipt}
                    onChange={(e) => setReceipt(e.target.value)}
                    placeholder="已提交表格链接、行号或回执编号"
                  />
                </Field>
                <div className="wide">
                  <Button
                    disabled={busy || !receipt.trim()}
                    onClick={() =>
                      run({
                        action: 'submit',
                        turnId: r.id,
                        receipt,
                        submitter,
                      })
                    }
                  >
                    <CheckCircle2 />
                    登记 AI 评测提交并锁定
                  </Button>
                </div>
              </div>
            </div>
          )}
          {r.status === 'submitted' && (
            <div className="sub" style={{ marginTop: 12 }}>
              已提交并锁定 · {fmt(r.submittedAt!)}
              <p className="mono">{r.receipt}</p>
              <details>
                <summary>查看已提交评分</summary>
                {dimensions.map((d, i) => (
                  <p key={d}>
                    {d}：{r.review?.scores[i]} 分 — {r.review?.descriptions[i]}
                  </p>
                ))}
              </details>
            </div>
          )}
          {['review', 'failed'].includes(r.status) && (
            <details style={{ marginTop: 16 }}>
              <summary className="sub">工程故障导致无反馈价值？</summary>
              <p className="sub">
                仅限网络或工程问题。模型能力问题仍需提交，不应排除。
              </p>
              <div className="actions">
                <label className="field" style={{ flex: 1 }}>
                  <span className="sr-only">工程故障说明</span>
                  <input
                    placeholder="人工填写具体工程故障原因"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    run({ action: 'exclude', turnId: r.id, reason })
                  }
                >
                  排除该轮
                </Button>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
