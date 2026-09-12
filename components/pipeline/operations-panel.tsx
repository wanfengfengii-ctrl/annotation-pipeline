'use client';
import { useEffect, useState } from 'react';
import type { OperationsReport } from '@/lib/operations-types';
const labels: Record<string, string> = {
  processing: '正在处理',
  waiting_model: '等待模型',
  stalled: '停滞待诊断',
  repairing: '修复中',
  repair_queued: '排队修复',
  waiting_input: '需要你处理',
  queued: '等待执行',
  archiving: '归档中',
  idle: '等待调度',
};
const stages: Record<string, string> = {
  context: '检查环境',
  scaffold: '准备骨架',
  prepare: '准备题目',
  policy: '审核题目',
  snapshot: '保存快照',
  claude: '生成代码',
  'runtime-plan': '安排验收',
  'runtime-running': '执行验收',
  'runtime-diagnose': '核对验收',
  score: '评分',
  delivery: '交付校验',
  'project-next': '规划后续',
  finalization: '归档',
};
const date = (v?: string | null) =>
  v
    ? new Date(v).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚无记录';
const number = (v?: number | null) =>
  typeof v === 'number' ? v.toLocaleString('zh-CN') : '未提供';
export function OperationsPanel({ local }: { local: boolean }) {
  const [data, setData] = useState<OperationsReport | null>(null),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('all'),
    [project, setProject] = useState('all'),
    [now, setNow] = useState(0);
  useEffect(() => {
    if (!local) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/operations', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('运行状态暂时无法读取');
        const result = (await response.json()) as {
          operations: OperationsReport | null;
        };
        if (!disposed) {
          setData(result.operations);
          setError('');
          setNow(Date.now());
        }
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setNow(Date.now());
        }
      } finally {
        if (!disposed) timer = setTimeout(refresh, 15000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [local]);
  if (!local) return null;
  const stale = data && now - Date.parse(data.checkedAt) > 120000;
  const rows = (data?.projects || []).filter(
    (p) =>
      (project === 'all' || p.taskId === project) &&
      (filter === 'all' ||
        (filter === 'active'
          ? ['processing', 'waiting_model', 'archiving'].includes(p.status)
          : filter === 'attention'
            ? [
                'stalled',
                'repairing',
                'repair_queued',
                'waiting_input',
              ].includes(p.status)
            : p.status === filter)),
  );
  const flow = data?.throughput?.flow,
    m = data?.metrics;
  return (
    <section className="operations-panel" aria-labelledby="operations-title">
      <div className="scheduler-heading">
        <h3 id="operations-title">生产进展与自动恢复</h3>
        <span className="tag">
          {!data
            ? '等待状态报告'
            : stale
              ? '状态报告已过期'
              : data.guardian.enabled
                ? '守护正在检查'
                : '守护已暂停'}
        </span>
      </div>
      <output className="sub">
        {error ||
          data?.observationError ||
          (!data
            ? '等待本机守护上报实际进展。'
            : `最近检查 ${date(data.checkedAt)}。`)}
        {stale ? ' 当前信息不是实时状态，请检查守护连接。' : ''}
        {data && !data.guardian.repairEnabled
          ? ' 新的模型修复暂未启用，现有生产任务继续执行。'
          : ''}
      </output>
      {data && (
        <>
          <div className="operations-metrics">
            {[
              ['近24小时新交付', flow?.firstDeliveries24h],
              ['近24小时返修交付', flow?.revalidations24h],
              ['累计质检通过', data.throughput?.counts?.qcPassed],
              ['近24小时修复调用', m?.modelInvocations],
              ['模型修复后恢复', m?.restored],
              ['固定流程恢复', m?.fixedRestored24h],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <span>{String(label)}</span>
                <strong>{number(value as number)}</strong>
              </div>
            ))}
          </div>
          <p className="sub">
            新增与返修从本次版本开始分别记账；旧记录缺少完整交付历史时不计作新增。质检状态来自最近一次上传台账同步。
          </p>
          <div className="operations-filters">
            <label>
              项目
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="all">全部项目</option>
                {data.projects.map((p) => (
                  <option key={p.taskId} value={p.taskId}>
                    {p.projectName || p.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              运行状态
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部状态</option>
                <option value="active">正在处理或等待模型</option>
                <option value="attention">有故障或正在恢复</option>
                <option value="waiting_input">需要你处理</option>
                <option value="queued">等待执行</option>
              </select>
            </label>
            <span className="sub">{rows.length} 个项目</span>
          </div>
          <div
            className="operations-table"
            aria-label="项目实际进展表，可横向滚动"
          >
            <table>
              <thead>
                <tr>
                  <th>项目</th>
                  <th>真实状态</th>
                  <th>当前步骤</th>
                  <th>最近进展</th>
                  <th>最近交付</th>
                  <th>原因与下一步</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.taskId}>
                    <td>
                      <strong>{p.projectName || p.title}</strong>
                      <div className="sub">{p.projectName ? p.title : ''}</div>
                    </td>
                    <td>
                      <span
                        className="tag"
                        data-tone={
                          ['waiting_input', 'stalled'].includes(p.status)
                            ? 'warning'
                            : 'normal'
                        }
                      >
                        {labels[p.status] || p.status}
                      </span>
                      <div className="sub">{p.owner}</div>
                    </td>
                    <td>{stages[p.stage] || p.stage || '等待'}</td>
                    <td>{date(p.lastProgressAt)}</td>
                    <td>{date(p.lastDeliveryAt)}</td>
                    <td>
                      {p.reason && <p>{p.reason}</p>}
                      <p className="sub">下一步：{p.next}</p>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6}>没有符合筛选条件的项目。</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <details className="scheduler-details">
            <summary>修复消耗与更新进度</summary>
            <p className="sub">
              近24小时共 {number(m?.attempts)} 次模型修复任务、
              {number(m?.modelInvocations)} 次阶段调用；其中{' '}
              {number(m?.usageKnown)} 次返回了用量。已知输入{' '}
              {number(m?.inputTokens)} tokens，输出 {number(m?.outputTokens)}{' '}
              tokens。未返回的用量不估算，发布补丁或排队不算恢复。
            </p>
            <p className="sub">
              归档模块：
              {!data.release.finalization
                ? '等待执行器首次交接'
                : data.release.finalization === data.release.target
                  ? '已采用当前版本'
                  : '等待当前归档完成后更新'}
              。补题模块：
              {data.release.supply === data.release.target
                ? '已采用当前版本'
                : '下次补题采用当前版本'}
              。进行中的会话保留原执行版本。
            </p>
            <ul className="operations-repairs">
              {m?.jobs
                ?.slice()
                .reverse()
                .map((j) => (
                  <li key={j.id}>
                    <strong>
                      {data.projects.find((p) => p.taskId === j.taskId)
                        ?.title || '流水线维护'}
                    </strong>{' '}
                    · {j.mode === 'escalation' ? '升级诊断' : '常规修复'} ·{' '}
                    {date(j.startedAt)}
                    <p>
                      {j.effect}；调用 {number(j.modelInvocations)} 次，耗时约{' '}
                      {Math.ceil((j.elapsedMs || 0) / 60000)} 分钟。
                    </p>
                  </li>
                ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
