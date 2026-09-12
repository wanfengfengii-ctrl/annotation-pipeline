'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { defaultScheduler, type SchedulerConfig } from '@/lib/scheduler';
import { ThroughputDetails } from './throughput-details';
import { OperationsPanel } from './operations-panel';
export function SchedulerPanel({
  runner,
  local,
}: {
  runner: any;
  local: boolean;
}) {
  const [config, setConfig] = useState<SchedulerConfig>(defaultScheduler);
  const [repos, setRepos] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch('/api/scheduler')
      .then((r) => {
        if (!r.ok) throw Error('调度配置加载失败');
        return r.json();
      })
      .then((d: any) => {
        setConfig(d.config);
        setRepos(d.config.repos.join('\n'));
        setLoaded(true);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  const s = runner?.scheduler;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const r = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...config,
          repos: repos
            .split('\n')
            .map((p) => p.trim())
            .filter(Boolean),
        }),
      });
      const d: any = await r.json();
      if (!r.ok) throw Error(d.error);
      setConfig(d.config);
      setMessage('已保存，下次调度生效；正在执行的任务会继续完成。');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="scheduler-panel">
      <div className="scheduler-heading">
        <div>
          <p className="eyebrow">AUTOMATIC SCHEDULER</p>
          <h2>自动补充与并行执行</h2>
        </div>
        <span className="tag">
          {s
            ? `${s.active} 个执行中 · 当前容量 ${s.effective} / 上限 ${s.configured}`
            : '等待执行器报告资源'}
        </span>
      </div>
      <p role="status" className="sub scheduler-status">
        {local
          ? s?.supply || '等待本机执行器连接'
          : '云端设置仅作用于云端队列；请在本机工作台配置本机执行器。'}
      </p>
      {s?.stages && (
        <p className="sub">
          阶段执行 {s.stages.running.length} / {s.stages.capacity} · 等待{' '}
          {s.stages.waiting.length} · 归档中 {s.finalizing || 0} · 候选题{' '}
          {s.queuedCandidates || 0} / {s.candidateBuffer || 2}。 Claude 最多 3
          个，重型验收最多 {s.stages.limits?.heavy ?? 3} 个，Codex 阶段最多{' '}
          {s.stages.limits?.codex ?? 3} 个，并受共享资源预算约束。
        </p>
      )}
      {s?.pilot?.status === 'pilot' && (
        <p className="sub">
          新流程先运行一条项目链，通过评分、交付和原终端归档后，自动恢复最多三个项目并行。
        </p>
      )}
      {s?.throughput && (
        <p className="sub">
          已评分 {s.throughput.counts.scored} · 已最终归档{' '}
          {s.throughput.counts.finalized} · 已上传{' '}
          {s.throughput.counts.submitted} · 质检通过{' '}
          {s.throughput.counts.qcPassed} · 待返修{' '}
          {s.throughput.counts.pendingFix}。 本次观察新增通过{' '}
          {s.throughput.newQcPassed} 条，已观察{' '}
          {s.throughput.observationHours.toFixed(1)} 小时。
          {s.throughput.comparisonReady
            ? '可查看同题型耗时样本。'
            : '累计满 24 小时后比较耗时与通过数量。'}
        </p>
      )}
      {s?.providerHealth?.pausedUntil && (
        <p className="sub">
          模型服务出现连续错误，新会话正在退避；现有会话继续保留，恢复时先运行一个新任务核实。
        </p>
      )}
      <OperationsPanel local={local} />
      <ThroughputDetails report={s?.throughput} />
      <details className="scheduler-details">
        <summary>资源与流程详情</summary>
        <p className="sub">
          保持最多两条已通过审核的候选题，在资源有余量时补充。Codex 先准备
          项目骨架和全新功能题，再依据实际产物生成新功能、迭代、修复、理解和重构题。目标比例
          7:7:10:1:1，独立题目新建 Terminal 会话，只有 Bug 修复沿用当前会话。
        </p>
        {s && (
          <p className="sub">
            {s.cpu} · {s.cores} 核 / {s.totalGB} GB · 可用及可回收内存约{' '}
            {s.availableGB} GB · 1 分钟负载 {s.load} · {s.reason}。
            {s.generating ? '正在准备候选题，与评分共享 Codex 额度。' : ''}
            {s.recovering
              ? ` ${s.recovering} 个旧任务等待进程退出，占用相应槽位。`
              : ''}
            今日补充 {s.generatedToday} / {s.dailyLimit} 个。
          </p>
        )}
        {s?.throughput?.groups
          ?.filter(
            (g: { completedAttempts: number }) => g.completedAttempts > 0,
          )
          .map(
            (g: {
              group: string;
              completedAttempts: number;
              medianElapsedMs: number;
            }) => (
              <p className="sub" key={g.group}>
                {g.group}：{g.completedAttempts} 次完成尝试，中位耗时{' '}
                {(g.medianElapsedMs / 60000).toFixed(1)} 分钟。
              </p>
            ),
          )}
        <p className="sub">
          GitHub CLI：
          {runner?.github?.available
            ? `已连接 ${runner.github.login} · ${runner.github.version}`
            : runner?.github?.error || '等待执行器检查'}
        </p>
        <p className="sub">
          禁出规则：{s?.ruleVersion || '等待执行器报告'}
          。自动出题先审核禁出、雷同与难度，再进入队列。
          {s?.lastAudit
            ? `最近审核：${s.lastAudit.allowed ? '通过' : '拦截'}，${s.lastAudit.reason}`
            : ''}
        </p>
        <p className="sub">
          流程规则：{s?.workflowVersion || '等待执行器报告'}
          。评分包含五维分档、过程与产物证据；每轮生成带 SHA-256
          清单的本地归档。
        </p>
        <div className="section">
          <h3>Docker 作业环境</h3>
          <p className="sub">{s?.docker?.reason || '等待执行器检查 Docker'}</p>
          {s?.docker?.ready && (
            <p className="sub">
              Docker 分配 {s.docker.cpus} 核 /{' '}
              {(s.docker.memoryBytes / 2 ** 30).toFixed(1)} GB，当前{' '}
              {s.residentContainers} 个项目容器保留。每个容器限制{' '}
              {s.resourceProfile?.cpus || 2} 核 /{' '}
              {(
                (s.resourceProfile?.memoryBytes || 3 * 2 ** 30) /
                2 ** 30
              ).toFixed(1)}
              GB，同时按宿主机余量限制并行数。
            </p>
          )}
          <p className="sub mono">
            {s?.docker?.image ||
              'adminfather/benzhi-claude-code:20260909-isolated-git'}
          </p>
          <p className="sub">
            新容器启动后导入骨架或上题代码；初始题加最多两轮 Bug
            修复，共三条对话，每会话保留十次调用硬上限。0-1 与 Feature
            每项目各最多十题。结束后核验并导出完整轨迹，保留代码。
          </p>
          <p className="sub">
            模型及 1,000,000 tokens
            配置沿用现状，执行器不覆盖模型、上下文或挂载宿主机配置。
          </p>
        </div>
        {s?.mix && (
          <p className="sub">
            累计有效轮次：
            {Object.entries(s.mix.totals || s.mix.counts)
              .map(([name, n]) => `${name} ${String(n)}`)
              .join(' · ')}
            。优先补充：{s.mix.suggested}。{s.mix.note}
          </p>
        )}
        <p className="sub">
          待外部完成：提供任务仓库、确认评审者仓库访问权限、原项目人工标注与外部表格提交。AI
          归档不代表已对外交付。
        </p>
      </details>
      <details>
        <summary>调度设置</summary>
        <form onSubmit={save} className="scheduler-form">
          <label className="scheduler-check" htmlFor="auto-continue">
            <Checkbox
              id="auto-continue"
              checked={config.autoContinue}
              onCheckedChange={(v) =>
                setConfig({ ...config, autoContinue: v === true })
              }
            />
            评分后自动出下一题或追问 Bug（每会话最多两次修复）
          </label>
          <label className="scheduler-check">
            <Checkbox
              checked={config.enabled}
              onCheckedChange={(v) =>
                setConfig({ ...config, enabled: v === true })
              }
            />
            队列为空时自动补充
          </label>
          <label className="scheduler-check">
            <Checkbox
              checked={config.useHistory}
              onCheckedChange={(v) =>
                setConfig({ ...config, useHistory: v === true })
              }
            />
            沿用手动创建任务的仓库
          </label>
          <label className="field">
            并发上限（1–4，资源紧张时自动降低）
            <input
              type="number"
              min="1"
              max="4"
              value={config.concurrency}
              onChange={(e) =>
                setConfig({ ...config, concurrency: Number(e.target.value) })
              }
            />
          </label>
          <label className="field">
            每日自动补充上限（上海时间）
            <input
              type="number"
              min="1"
              max="100"
              value={config.dailyLimit}
              onChange={(e) =>
                setConfig({ ...config, dailyLimit: Number(e.target.value) })
              }
            />
          </label>
          <label className="field wide">
            指定仓库（本机绝对路径，每行一个）
            <textarea
              rows={3}
              placeholder="/Users/你的用户名/projects/repository"
              value={repos}
              onChange={(e) => setRepos(e.target.value)}
            />
          </label>
          <label className="field wide">
            Codex 出题范围
            <textarea
              rows={3}
              value={config.scope}
              onChange={(e) => setConfig({ ...config, scope: e.target.value })}
            />
          </label>
          <p className="sub wide">
            每次补充后至少间隔 60 秒。失败后从 5 分钟开始退避；最近 3
            个自动任务均失败时停止补充，处理失败任务后恢复。降低并发不会中断正在运行的任务。
          </p>
          <Button disabled={busy || !loaded} type="submit">
            {busy ? '保存中…' : '保存调度设置'}
          </Button>
        </form>
      </details>
      {message && (
        <p role="status" className="sub scheduler-status">
          {message}
        </p>
      )}
    </section>
  );
}
