const minutes = (v: unknown) =>
  typeof v === 'number' ? `${(v / 60000).toFixed(1)} 分钟` : '缺少计时';
export function ThroughputDetails({ report }: { report: any }) {
  if (!report?.bottlenecks) return null;
  return (
    <details className="section">
      <summary>原题耗时与阶段瓶颈（最近 30 题明细）</summary>
      <p className="sub">
        继续和失败尝试归到原题；排队与执行分别统计，缺失历史不推算。阶段可能重叠，不将各阶段相加当作总耗时。
      </p>
      {report.logicalSummary && (
        <p>
          独立题 {report.logicalSummary.records} 条 · 一次交付{' '}
          {report.logicalSummary.firstPass} 条 · 恢复后交付{' '}
          {report.logicalSummary.recovered} 条 · 原题交付中位耗时{' '}
          {minutes(report.logicalSummary.medianDeliveryMs)} · 缺少首次交付时间{' '}
          {report.logicalSummary.missingDeliveryTimeline} 条
        </p>
      )}
      <div className="record-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>题型 / 难度 / 版本 / 阶段</th>
              <th>执行中位数</th>
              <th>排队中位数</th>
              <th>完成样本</th>
              <th>失败 / 进行中</th>
            </tr>
          </thead>
          <tbody>
            {report.bottlenecks.slice(0, 15).map((g: any) => (
              <tr key={g.group}>
                <td>{g.group}</td>
                <td>{minutes(g.medianMs)}</td>
                <td>{minutes(g.queueMedianMs)}</td>
                <td>{g.samples}</td>
                <td>
                  {g.failures} / {g.ongoing}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(report.logicalTimings || []).slice(0, 30).map((r: any) => (
        <details key={`${r.taskId}:${r.turnId}`}>
          <summary>
            {r.category} · {r.turnId} ·{' '}
            {r.firstDeliveredAt ? '首次交付' : '观察至今'} {minutes(r.wallMs)}
          </summary>
          <p>
            实际执行 {minutes(r.activeMs)} · 排队 {minutes(r.queueMs)} ·{' '}
            {r.attempts} 次尝试 · 重复阶段 {r.repeatedStages} 次
          </p>
          <p>
            其他间隔 {minutes(r.unaccountedMs)}，包含阶段切换和等待；缺失区间{' '}
            {r.missingIntervals} 个。
          </p>
          {r.stages.map((s: any) => (
            <p key={`${s.attemptId}:${s.spanId}`}>
              {s.stage}：{s.ongoing ? '进行中' : s.outcome || '未结束'} · 执行{' '}
              {minutes(s.elapsedMs)} · 排队 {minutes(s.queueMs)}
            </p>
          ))}
        </details>
      ))}
    </details>
  );
}
