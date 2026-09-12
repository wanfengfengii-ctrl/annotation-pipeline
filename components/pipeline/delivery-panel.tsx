'use client';
import { useEffect, useRef, useState } from 'react';
import { latestRequest } from '@/lib/latest-request.mjs';
import { dimensions } from '@/lib/pipeline';
import { Button } from '@/components/ui/button';
export function DeliveryPanel({ taskId }: { taskId: string }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [selectedVersion, setSelectedVersion] = useState(''),
    [versions, setVersions] = useState<any[]>([]);
  const requests = useRef(latestRequest());
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setData(null);
    setError('');
    const refresh = async () => {
      const current = requests.current.begin();
      try {
        const r = await fetch(
          `/api/tasks/${encodeURIComponent(taskId)}/delivery${selectedVersion ? '?version=' + selectedVersion : ''}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const d: any = await r.json();
        if (!r.ok) throw Error(d.error || '交付详情读取失败');
        if (current() && !disposed && d.taskId === taskId) {
          setData(d);
          if (d.versions) setVersions(d.versions);
          setError('');
        }
      } catch (e) {
        if (current() && !disposed) setError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(refresh, 15000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      requests.current.invalidate();
    };
  }, [taskId, selectedVersion]);
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `delivery-${taskId}-${data.version.slice(0, 12)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="section delivery-panel">
      <div className="scheduler-heading">
        <h3>交付追溯</h3>
        <Button
          variant="outline"
          disabled={!data || data.taskId !== taskId}
          onClick={download}
        >
          下载内部交付明细
        </Button>
      </div>
      <label>
        交付版本{' '}
        <select
          value={selectedVersion}
          onChange={(e) => {
            requests.current.invalidate();
            setSelectedVersion(e.target.value);
          }}
        >
          <option value="">当前版本</option>
          {versions.map((v) => (
            <option key={v.version} value={v.version}>
              {new Date(v.createdAt).toLocaleString('zh-CN')} ·{' '}
              {v.version.slice(0, 12)}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">正在读取交付记录…</p>}
      {data?.taskId === taskId &&
        data.entries.map((r: any) => (
          <details key={r.turnId}>
            <summary>
              {r.category || '待核对'} · {r.prompt}
            </summary>
            <p>
              原题 ID：{r.turnId} · 结果 ID：{r.resultTurnId || '待核对'}
            </p>
            <p>SessionID：{r.sessionId || '缺失'}</p>
            <p>原题消息 UUID：{r.messageUuid || '缺失'}</p>
            <p>原生 PromptID：{r.nativePromptId || '尚未核验同步'}</p>
            {r.initial?.url &&
              /^https:\/\/github\.com\//.test(r.initial.url) && (
                <p>
                  <a href={r.initial.url} target="_blank" rel="noreferrer">
                    初始代码快照
                  </a>
                </p>
              )}
            <p>
              本题实际调用{' '}
              {r.chain?.reduce((n: number, c: any) => n + c.actualCalls, 0) ||
                0}{' '}
              次 · 继续 {Math.max(0, (r.chain?.length || 1) - 1)} 次 · Excel
              导出 {r.exportCount || 0} 次
            </p>
            {r.missing?.length > 0 && (
              <ul>
                {r.missing.map((m: string) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            {(
              ['product', 'facts', 'runtime', 'archive', 'finalTrace'] as const
            ).map((key, i) => (
              <p key={key}>
                {
                  [
                    '完成代码清单',
                    '评分事实索引',
                    '运行验收',
                    '内部归档',
                    '最终原生轨迹',
                  ][i]
                }
                ：<span className="mono">{r[key]?.sha256 || '尚无摘要'}</span>
                {r[key]?.path && (
                  <>
                    <br />
                    {r[key].path}
                  </>
                )}
              </p>
            ))}
            {r.score && (
              <div>
                {dimensions.map((d, i) => (
                  <p key={d}>
                    <strong>
                      {d} {r.score.scores[i]} 分
                    </strong>
                    ：{r.score.descriptions[i]}
                  </p>
                ))}
                <p>
                  评分来源：
                  {r.scoreSource === 'codex'
                    ? 'AI'
                    : r.scoreSource || '未记录'}{' '}
                  · 人工确认：{r.human?.state || '待本人确认'}
                </p>
              </div>
            )}
            {r.revisions?.length > 0 && (
              <details>
                <summary>评分修订记录（{r.revisions.length}）</summary>
                {r.revisions.map((v: any, i: number) => (
                  <div key={i}>
                    <h4>{v.kind}</h4>
                    <pre>{JSON.stringify(v, null, 2)}</pre>
                  </div>
                ))}
              </details>
            )}
            {r.runtimeRecovery && (
              <p>
                验收恢复：{r.runtimeRecovery.state} · 已完成{' '}
                {r.runtimeRecovery.completedIds.length} 项 ·{' '}
                {r.runtimeRecovery.reason}
              </p>
            )}
          </details>
        ))}
    </section>
  );
}
