'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { soloStatusLabels } from '@/lib/solo-upload-status.mjs';
import {
  batchNeedsReconciliation,
  canRequestBatchRecovery,
} from '@/lib/upload-batches.mjs';
const labels: Record<string, string> = {
  running: '正在上传',
  awaiting_reconcile: '租期已过，待核对',
  waiting_resume: '等待续传本批',
  waiting_login: '等待登录',
  waiting_window: '等待上传窗口',
  completed: '批次已处理',
  blocked: '存在暂缓项',
  failed: '等待恢复',
};
export function UploadBatchesPanel({
  local,
  onOpen,
}: {
  local: boolean;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const c = new AbortController();
    async function refresh() {
      try {
        const r = await fetch('/api/solo-upload', {
          cache: 'no-store',
          signal: c.signal,
        });
        if (!r.ok) throw Error('上传批次读取失败');
        const d: any = await r.json();
        if (!disposed) {
          setData(d.upload);
          setError('');
        }
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      } finally {
        if (!disposed) timer = setTimeout(refresh, 15000);
      }
    }
    void refresh();
    return () => {
      disposed = true;
      c.abort();
      clearTimeout(timer);
    };
  }, []);
  async function resume(b: any) {
    setBusy(b.slot);
    setMessage('');
    try {
      const r = await fetch('/api/solo-upload/recovery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'request',
          slot: b.slot,
          revision: b.revision,
        }),
      });
      const d: any = await r.json();
      if (!r.ok) throw Error(d.error);
      setMessage(d.message);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const rows = (data?.batches || [])
      .map((b: any) => ({
        ...b,
        displayStatus: batchNeedsReconciliation(b)
          ? 'awaiting_reconcile'
          : b.status,
      }))
      .filter((b: any) => filter === 'all' || b.displayStatus === filter),
    pages = Math.max(1, Math.ceil(rows.length / 5));
  return (
    <section className="section upload-batches-panel">
      <h2>上传批次</h2>
      <p className="sub">
        {data
          ? `状态更新于 ${new Date(data.checkedAt).toLocaleString('zh-CN')}`
          : '等待本机上传状态同步'}
        。已提交与质检通过分别记录。
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <label>
        批次状态{' '}
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部</option>
          {Object.entries(labels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {!rows.length && <p>暂无匹配批次；单条上传状态仍可在标注数据中查看。</p>}
      {rows.slice((page - 1) * 5, page * 5).map((b: any) => (
        <details key={b.slot}>
          <summary>
            {b.slot} · {labels[b.displayStatus] || b.displayStatus} ·{' '}
            {b.rows.length} 条
          </summary>
          <p>
            处理尝试 {b.attempts} 次 {b.reasonCode ? `· ${b.reasonCode}` : ''}
          </p>
          {b.pauseReason && <p>{b.pauseReason}</p>}
          {b.displayStatus === 'awaiting_reconcile' && (
            <p>
              需要原上传任务核对是否仍在执行及远端回执，确认后续传；租期到期不会自动重发。
            </p>
          )}
          {local && b.rows.length > 0 && canRequestBatchRecovery(b) && (
            <Button
              variant="outline"
              disabled={!!busy}
              onClick={() => resume(b)}
            >
              {busy === b.slot ? '正在排队…' : '重新核验并续传本批'}
            </Button>
          )}
          {b.rows.map((r: any) => (
            <div className="section" key={r.key}>
              <Button
                variant="link"
                onClick={() => onOpen(r.key.split(':')[0])}
              >
                查看原题 {r.key}
              </Button>
              <p>
                {soloStatusLabels[r.status as keyof typeof soloStatusLabels] ||
                  r.status}{' '}
                · {r.next}
              </p>
              {r.reason && <p>{r.reason}</p>}
              {r.remoteId && (
                <a
                  href={`https://solo2.jzxhnh.com/app/submissions/${r.remoteId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  平台记录 {r.remoteId}
                </a>
              )}
            </div>
          ))}
        </details>
      ))}
      <div className="record-pagination">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          上一页
        </Button>
        <span>
          第 {page} / {pages} 页
        </span>
        <Button
          variant="outline"
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </Button>
      </div>
    </section>
  );
}
