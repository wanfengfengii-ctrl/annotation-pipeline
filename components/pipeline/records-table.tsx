'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  recordKey,
  type RecordIdentity,
  type ExportScope,
} from '@/lib/record-selection';
import { categories } from '@/lib/pipeline';
import {
  recordHeaders,
  recordCategory,
  snapshotLink,
  type RecordFilter,
  type RecordRow,
  type RecordSource,
} from '@/lib/record-fields';
export function RecordsTable({
  source = 'ai',
  projects,
  onOpen,
}: {
  source?: RecordSource;
  projects: { id: string; name: string }[];
  onOpen: (taskId: string) => void;
}) {
  const [filter, setFilter] = useState<RecordFilter>({
    source,
    projectId: '',
    query: '',
    category: '',
    day: '',
    exports: 'all',
    count: 0,
    page: 1,
    pageSize: 20,
  });
  const [data, setData] = useState<{
      rows: RecordRow[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    } | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [refresh, setRefresh] = useState(0),
    [format, setFormat] = useState('xlsx');
  const [selected, setSelected] = useState<Record<string, RecordIdentity>>({});
  const selectedCount = Object.keys(selected).length;
  const pageRows = data?.rows.filter((r) => r.eligible) || [];
  const checkedOnPage = pageRows.filter((r) => selected[recordKey(r)]).length;
  const pending = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetch(
      '/api/records?' +
        new URLSearchParams(
          Object.fromEntries(
            Object.entries(filter).map(([k, v]) => [k, String(v)]),
          ),
        ),
      { signal: controller.signal },
    )
      .then(async (r) => {
        const d = (await r.json()) as NonNullable<typeof data> & {
          error?: string;
        };
        if (!r.ok) throw Error(d.error);
        if (controller.signal.aborted) return;
        setData(d);
        setSelected((current) => {
          const next = { ...current };
          for (const r of d.rows) if (!r.eligible) delete next[recordKey(r)];
          return next;
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filter, refresh]);
  const update = (patch: Partial<RecordFilter>, resetSelection = true) => {
    setLoading(true);
    if (resetSelection) setSelected({});
    setFilter((f) => ({ ...f, ...patch, page: 1 }));
  };
  const toggle = (rows: RecordIdentity[], checked: boolean) => {
    const next = { ...selected };
    for (const r of rows) {
      if (checked) next[recordKey(r)] = { taskId: r.taskId, turnId: r.turnId };
      else delete next[recordKey(r)];
    }
    if (Object.keys(next).length > 1000) {
      setError('每批最多勾选 1000 条，请先导出已勾选记录');
      return;
    }
    setSelected(next);
  };
  async function download(scope: ExportScope) {
    setBusy(true);
    setError('');
    setMessage('');
    const selection = {
        filter,
        scope,
        format,
        ...(scope === 'selected' ? { selected: Object.values(selected) } : {}),
      },
      signature = JSON.stringify(selection);
    if (pending.current?.signature !== signature)
      pending.current = { signature, id: crypto.randomUUID() };
    try {
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selection, requestId: pending.current.id }),
      });
      if (!r.ok) {
        const d = (await r.json()) as { error: string };
        throw Error(d.error);
      }
      const blob = await r.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `annotation-${r.headers.get('X-Export-Batch')}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      pending.current = null;
      setSelected({});
      setMessage(
        `已生成 ${r.headers.get('X-Export-Count')} 条记录的 ${format.toUpperCase()}，导出次数已记录。`,
      );
      setRefresh((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel record-panel">
      <div className="panelhead">
        <h2>标注数据</h2>
        <Button
          variant="ghost"
          onClick={() => setRefresh((x) => x + 1)}
          disabled={loading || busy}
        >
          刷新
        </Button>
      </div>
      <fieldset className="record-filters" disabled={busy}>
        <label className="field">
          项目名称
          <select
            value={filter.projectId || ''}
            onChange={(e) => update({ projectId: e.target.value })}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          评分来源
          <select
            value={filter.source}
            onChange={(e) => update({ source: e.target.value as RecordSource })}
          >
            <option value="ai">AI 评分</option>
            <option value="human">人工二次确认</option>
          </select>
        </label>
        <label className="field">
          任务、Prompt 或会话
          <input
            value={filter.query}
            maxLength={300}
            onChange={(e) => update({ query: e.target.value })}
          />
        </label>
        <label className="field">
          任务类型
          <select
            value={filter.category}
            onChange={(e) => update({ category: e.target.value })}
          >
            <option value="">全部类型</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {recordCategory(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          产生日期（上海）
          <input
            type="date"
            value={filter.day}
            onChange={(e) => update({ day: e.target.value })}
          />
        </label>
        <label className="field">
          导出次数
          <select
            value={filter.exports}
            onChange={(e) =>
              update({ exports: e.target.value as RecordFilter['exports'] })
            }
          >
            <option value="all">全部</option>
            <option value="never">未导出（0 次）</option>
            <option value="exported">已导出（至少 1 次）</option>
            <option value="exact">指定次数</option>
          </select>
        </label>
        {filter.exports === 'exact' && (
          <label className="field">
            次数
            <input
              type="number"
              min={0}
              max={1000000}
              value={filter.count}
              onChange={(e) => update({ count: Number(e.target.value) })}
            />
          </label>
        )}
      </fieldset>
      <div className="record-toolbar">
        <label className="field">
          导出格式
          <select
            value={format}
            disabled={busy}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV（完整长文本）</option>
          </select>
        </label>
        <Button
          disabled={busy || loading || !selectedCount}
          onClick={() => download('selected')}
        >
          导出勾选记录（{selectedCount}）
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !selectedCount}
          onClick={() => setSelected({})}
        >
          清空勾选
        </Button>
        <Button
          variant="outline"
          disabled={busy || loading || !data?.rows.some((r) => r.eligible)}
          onClick={() => download('page')}
        >
          导出本页
        </Button>
        <Button
          variant="outline"
          disabled={busy || loading || !data?.total}
          onClick={() => download('filtered')}
        >
          导出筛选结果
        </Button>
        <span className="sub">
          仅导出通过校验的轮次；每批最多 1000
          条。次数按每条轮次成功生成的表格累计。
        </span>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {message && <output className="sub">{message}</output>}
      {loading && (
        <p role="status" className="record-status sub">
          正在读取标注记录…
        </p>
      )}
      <p className="record-status sub">
        表头复选框选择本页可导出记录，翻页保留勾选，修改筛选条件会清空勾选。左右滚动可查看全部字段。
      </p>
      <div
        className="record-scroll"
        aria-label="标注字段表格，可横向滚动"
        role="region"
        tabIndex={0}
        aria-busy={loading}
      >
        <table className="record-table">
          <thead>
            <tr>
              <th className="record-select">
                <Checkbox
                  aria-label="选择本页全部可导出记录"
                  checked={
                    pageRows.length > 0 && checkedOnPage === pageRows.length
                  }
                  indeterminate={
                    checkedOnPage > 0 && checkedOnPage < pageRows.length
                  }
                  disabled={busy || loading || !pageRows.length}
                  onCheckedChange={(checked) => toggle(pageRows, checked)}
                />
              </th>
              <th className="record-serial">序号</th>
              {recordHeaders.map((h, i) => (
                <th key={h} className={i === 0 ? 'record-prompt' : undefined}>
                  {h}
                </th>
              ))}
              <th>导出次数</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {!loading &&
              data?.rows.map((row, index) => (
                <tr
                  key={recordKey(row)}
                  data-selected={!!selected[recordKey(row)]}
                >
                  <td className="record-select">
                    <Checkbox
                      aria-label={`选择第 ${(data.page - 1) * data.pageSize + index + 1} 条记录`}
                      checked={!!selected[recordKey(row)]}
                      disabled={busy || !row.eligible}
                      onCheckedChange={(checked) => toggle([row], checked)}
                    />
                  </td>
                  <td className="record-serial">
                    {(data.page - 1) * data.pageSize + index + 1}
                  </td>
                  {row.values.map((v, i) => (
                    <td
                      key={i}
                      className={i === 0 ? 'record-prompt' : undefined}
                    >
                      {recordHeaders[i] === '初始环境快照' &&
                      snapshotLink(String(v)) ? (
                        <a
                          href={String(v)}
                          target="_blank"
                          rel="noreferrer"
                          title={String(v)}
                        >
                          {String(v)} ↗
                        </a>
                      ) : String(v).length > 100 ? (
                        <details>
                          <summary>{String(v).slice(0, 100)}…</summary>
                          <pre>{v}</pre>
                        </details>
                      ) : v === 0 || v ? (
                        v
                      ) : (
                        '—'
                      )}
                    </td>
                  ))}
                  <td>
                    <span className="tag">{row.exportCount} 次</span>
                    <p className="sub">{row.eligible ? '可导出' : '待校验'}</p>
                  </td>
                  <td>
                    <Button variant="ghost" onClick={() => onOpen(row.taskId)}>
                      打开任务
                    </Button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && !error && !data?.rows.length && (
        <div className="blank">
          <h3>当前筛选没有标注记录</h3>
          <p className="sub">
            {filter.source === 'human'
              ? '完成人工二次确认后，可在这里查看对应记录。'
              : 'AI 评分完成后将自动出现，人工确认可稍后完成。'}
          </p>
        </div>
      )}
      <div className="record-pagination">
        <span className="sub">
          共 {data?.total || 0} 条 · 第 {data?.page || 1} /{' '}
          {data?.totalPages || 1} 页
        </span>
        <label className="field">
          每页
          <select
            value={filter.pageSize}
            disabled={busy}
            onChange={(e) =>
              update({ pageSize: Number(e.target.value) }, false)
            }
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={busy || loading || !data || data.page <= 1}
          onClick={() =>
            setFilter((f) => ({ ...f, page: (data?.page || 1) - 1 }))
          }
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={busy || loading || !data || data.page >= data.totalPages}
          onClick={() =>
            setFilter((f) => ({ ...f, page: (data?.page || 1) + 1 }))
          }
        >
          下一页
        </Button>
      </div>
      <p className="sub" style={{ padding: '0 24px 20px' }}>
        导出主表在原有 30 个字段前增加序号，每批从 1 开始；Excel
        的“来源与导出记录”工作表单独保留 AI /
        人工来源及原始字段。轨迹列显示实际文件名，完整路径与快照明细保留在来源表中，文件名不代表已上传附件。
      </p>
    </section>
  );
}
