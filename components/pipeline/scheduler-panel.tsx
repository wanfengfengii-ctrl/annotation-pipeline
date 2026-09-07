'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { defaultScheduler, type SchedulerConfig } from '@/lib/scheduler';
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
          <p className="sub">
            待执行队列为空且有空闲容量时，由 Codex
            生成一个新任务。每个任务在独立工作目录执行。
          </p>
        </div>
        <span className="tag">
          {s
            ? `${s.active} 个执行中 · 当前容量 ${s.effective} / 上限 ${s.configured}`
            : '等待执行器报告资源'}
        </span>
      </div>
      {s && (
        <p className="sub">
          {s.cpu} · {s.cores} 核 / {s.totalGB} GB · 可用及可回收内存约{' '}
          {s.availableGB} GB · 1 分钟负载 {s.load} · {s.reason}。
          {s.generating ? '出题占用 1 个槽位。' : ''}
          {s.recovering
            ? ` ${s.recovering} 个旧任务等待进程退出，占用相应槽位。`
            : ''}
          今日补充 {s.generatedToday} / {s.dailyLimit} 个。
        </p>
      )}
      <p role="status" className="sub">
        {local
          ? s?.supply || '等待本机执行器连接'
          : '云端设置仅作用于云端队列；请在本机工作台配置本机执行器。'}
      </p>
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
        。评分包含五维分档、过程与产物证据；每轮生成带 SHA-256 清单的本地归档。
      </p>
      {s?.mix && (
        <p className="sub">
          今日有效轮次：
          {Object.entries(s.mix.counts)
            .map(([name, n]) => `${name} ${String(n)}`)
            .join(' · ')}
          。优先补充：{s.mix.suggested}。{s.mix.note}
        </p>
      )}
      <p className="sub">
        待外部完成：提供任务仓库、确认评审者仓库访问权限、原项目人工标注与外部表格提交。AI
        归档不代表已对外交付。
      </p>
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
            每轮评分后自动判断并续跑（最多 10 轮）
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
          {message && (
            <p role="status" className="sub wide">
              {message}
            </p>
          )}
        </form>
      </details>
    </section>
  );
}
