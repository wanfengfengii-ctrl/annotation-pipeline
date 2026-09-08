'use client';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { dimensions, type Task, type Turn } from '@/lib/pipeline';
import {
  draftFromAI,
  normalizeHumanDraft,
  humanMaterials,
  humanQualityReasons,
  humanLabel,
  humanIssues,
  type HumanDraft,
} from '@/lib/human-review';
export function HumanReviewPanel({
  task,
  turn: r,
  run,
  busy,
}: {
  task: Task;
  turn: Turn;
  run: (body: object) => Promise<boolean>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<HumanDraft>(
    () => r.humanReview?.draft || draftFromAI(r),
  );
  const [receipt, setReceipt] = useState(''),
    [allChecked, setAllChecked] = useState(false),
    [returnReason, setReturnReason] = useState(''),
    [message, setMessage] = useState('');
  const [history, setHistory] = useState<
    | {
        id: string;
        action: string;
        created_at: string;
        data: { actor: string; review: unknown };
      }[]
    | null
  >(null);
  useEffect(() => {
    if (r.humanReview?.receipt) setDraft(r.humanReview.draft);
  }, [r.humanReview?.receipt]);
  const h = r.humanReview,
    locked = !!h?.receipt,
    dirty = !h || JSON.stringify(draft) !== JSON.stringify(h.draft),
    flags = humanQualityReasons(r, draft),
    materials = humanMaterials(r, draft);
  const edit = (key: keyof HumanDraft, value: string | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function act(action: string, extra: object = {}) {
    setMessage('');
    if (await run({ humanAction: action, turnId: r.id, ...extra })) {
      setMessage(
        action === 'save'
          ? '草稿已保存'
          : action === 'finalize'
            ? '已提交人工核验，请查看最新状态'
            : '记录已保存',
      );
      if (action === 'save' || action === 'finalize')
        setDraft(normalizeHumanDraft(draft));
      setHistory(null);
    }
  }
  async function loadHistory() {
    try {
      const res = await fetch(
        `/api/tasks/${task.id}/human-review?turnId=${r.id}`,
      );
      const d = (await res.json()) as {
        error?: string;
        history: NonNullable<typeof history>;
      };
      if (!res.ok) throw Error(d.error || '历史记录读取失败');
      setHistory(d.history);
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <section className="human-review section">
      <div className="actions">
        <h3>人工二次确认</h3>
        <span className="tag">{humanLabel(r)}</span>
      </div>
      <p className="sub">
        以下评分和评语由 AI
        预填。请核对实际产物和证据，填写本人检查结果；修改会另存为人工复核记录。自动流水线继续运行。
      </p>
      {h?.reworkReason && <p className="issue">待补充：{h.reworkReason}</p>}
      <details>
        <summary>查看保留的 AI 原始评分</summary>
        <pre>{JSON.stringify(r.review, null, 2)}</pre>
      </details>
      <details className="human-evidence">
        <summary>需求、轨迹与代码变更证据</summary>
        <p className="sub">
          引用格式：证据编号:行号，如 output:1。AI
          已校验的原始文件引用可保留；完整文件和归档位于执行器所在电脑。
        </p>
        {materials.map((m) => (
          <details key={m.id}>
            <summary>
              {m.label} · {m.id}
              {m.truncated ? ' · 仅显示节选' : ''}
            </summary>
            <p className="sub mono">
              {m.originalPath}
              {m.sha256 && ` · SHA-256 ${m.sha256}`}
            </p>
            <pre>
              {m.content
                .split('\n')
                .map((line, i) => `${i + 1}  ${line}`)
                .join('\n')}
            </pre>
          </details>
        ))}
        {!r.evidence && (
          <p className="issue">
            历史轮次尚无页面轨迹预览，请结合上方本机轨迹和归档路径核验。
          </p>
        )}
      </details>
      <fieldset disabled={locked || busy} className="human-fields">
        <label className="field">
          确认人（本人姓名）
          <input
            maxLength={100}
            value={draft.reviewer}
            onChange={(e) => edit('reviewer', e.target.value)}
            autoComplete="name"
          />
        </label>
        <label className="field">
          本人实际核验记录
          <textarea
            rows={4}
            maxLength={6000}
            value={draft.verification}
            onChange={(e) => edit('verification', e.target.value)}
            placeholder="写明实际运行的命令、操作步骤、预期与观察结果；未运行的测试请明确说明。此栏不由 AI 预填。"
          />
        </label>
        <div className="reviewgrid">
          {dimensions.map((name, i) => {
            const f = draft.findings[i];
            return (
              <details className="scorebox" key={name}>
                <summary>
                  {name} · AI {r.review?.scores[i] || '—'} 分 / 复核{' '}
                  {f.score || '未填'} 分
                  {r.review?.scores[i] !== f.score ? ' · 已调整' : ''}
                </summary>
                <label className="field">
                  确认分数
                  <select
                    value={f.score}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        findings: d.findings.map((v, j) =>
                          i === j ? { ...v, score: Number(e.target.value) } : v,
                        ),
                      }))
                    }
                  >
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n || '未评分'}
                      </option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    ['when', '发生节点'],
                    ['behavior', '实际行为'],
                    ['impact', '影响'],
                    ['expected', '正确做法'],
                    ['evidenceRefs', '证据引用（每行一个）'],
                  ] as const
                ).map(([key, label]) => (
                  <label className="field" key={key}>
                    {label}
                    <textarea
                      rows={2}
                      maxLength={key === 'evidenceRefs' ? 1000 : 1600}
                      value={f[key]}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          findings: d.findings.map((v, j) =>
                            i === j ? { ...v, [key]: e.target.value } : v,
                          ),
                        }))
                      }
                    />
                  </label>
                ))}
              </details>
            );
          })}
        </div>
        <div className="reviewgrid">
          <label className="field">
            过程核验结论
            <textarea
              rows={3}
              maxLength={1600}
              value={draft.process}
              onChange={(e) => edit('process', e.target.value)}
            />
          </label>
          <label className="field">
            产物核验结论
            <textarea
              rows={3}
              maxLength={1600}
              value={draft.artifact}
              onChange={(e) => edit('artifact', e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          其他问题
          <textarea
            rows={2}
            maxLength={1600}
            value={draft.other}
            onChange={(e) => edit('other', e.target.value)}
          />
        </label>
        {!!flags.length && (
          <div className="human-quality">
            <p>本轮需重点核对：</p>
            <ul>
              {flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <label className="field">
              对上述问题的二次核验依据
              <textarea
                rows={3}
                maxLength={3000}
                value={draft.qualityResolution}
                onChange={(e) => edit('qualityResolution', e.target.value)}
                placeholder="检查了什么证据，为什么确认或调整该评分"
              />
            </label>
          </div>
        )}
        <label className="human-check">
          <input
            type="checkbox"
            checked={draft.attested}
            onChange={(e) => edit('attested', e.target.checked)}
          />
          本人已实际检查过程与产物，并核对以上 AI 评分及修改内容。
        </label>
        <div className="actions">
          <Button
            variant="outline"
            disabled={!draft.reviewer.trim()}
            onClick={() => act('save', { draft })}
          >
            保存草稿
          </Button>
          <Button
            disabled={!draft.reviewer.trim() || !draft.attested}
            onClick={() => act('finalize', { draft })}
          >
            确认评分并检查完整性
          </Button>
        </div>
      </fieldset>
      {h?.state === 'needs_second_review' && (
        <p className="issue">请补充重点问题的核验依据，再提交确认。</p>
      )}
      {h?.state === 'approved' && !locked && (
        <details className="human-delivery" open>
          <summary>人工确认通过 · 交付登记</summary>
          <p className="sub">
            {dirty ? '有尚未保存的修改，请重新提交确认后再登记。' : ''}
            人工确认不代表已提交到外部平台。全部有效轮次核验通过后，再登记实际回执。
          </p>
          <label className="field">
            外部回执或表格行号
            <input
              value={receipt}
              onChange={(e) => setReceipt(e.target.value)}
              maxLength={2000}
            />
          </label>
          <label className="human-check">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={(e) => setAllChecked(e.target.checked)}
            />
            已核对本会话全部有效轮次，无遗漏。
          </label>
          <Button
            disabled={busy || dirty || !receipt.trim() || !allChecked}
            onClick={() =>
              act('receipt', {
                receipt,
                actor: draft.reviewer,
                allRoundsChecked: allChecked,
              })
            }
          >
            登记人工交付并锁定
          </Button>
        </details>
      )}
      {locked && (
        <p className="sub">
          人工交付已锁定 · {h.deliveredAt} · {h.receipt}
        </p>
      )}
      {h && !locked && (
        <details>
          <summary>证据不足，标记待补充</summary>
          <label className="field">
            需修改或补充的内容
            <textarea
              value={returnReason}
              maxLength={3000}
              onChange={(e) => setReturnReason(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !returnReason.trim() || !draft.reviewer.trim()}
            onClick={() =>
              act('return', { actor: draft.reviewer, reason: returnReason })
            }
          >
            标记待返工
          </Button>
        </details>
      )}
      <div className="actions">
        <Button variant="ghost" onClick={loadHistory}>
          查看修改记录
        </Button>
        <a
          href={`/api/tasks/${task.id}/human-review?turnId=${r.id}&download=1`}
        >
          下载确认记录 JSON
        </a>
      </div>
      {history && (
        <div className="human-history">
          {history.length ? (
            history.map((v) => (
              <details key={v.id}>
                <summary>
                  {v.created_at} · {v.data.actor} ·{' '}
                  {(
                    {
                      save: '保存草稿',
                      finalize: '提交人工核验',
                      return: '标记待返工',
                      receipt: '登记交付',
                    } as Record<string, string>
                  )[v.action] || v.action}
                </summary>
                <pre>{JSON.stringify(v.data.review, null, 2)}</pre>
              </details>
            ))
          ) : (
            <p className="sub">还没有人工确认记录。</p>
          )}
        </div>
      )}
      {message && <output className="sub">{message}</output>}
      <p className="sub">
        {humanIssues(task, r).length
          ? `尚有 ${humanIssues(task, r).length} 项待核对`
          : '可导出人工复核结果'}{' '}
        · 来源始终保留为 AI 评分 / 人工二次确认。
      </p>
    </section>
  );
}
