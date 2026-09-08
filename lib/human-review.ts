import type { Task, Turn, Review } from './pipeline';
export type Finding = {
  score: number;
  when: string;
  behavior: string;
  impact: string;
  expected: string;
  evidenceRefs: string;
};
export type HumanDraft = {
  reviewer: string;
  verification: string;
  process: string;
  artifact: string;
  other: string;
  qualityResolution: string;
  attested: boolean;
  findings: Finding[];
};
export type HumanReview = {
  draft: HumanDraft;
  state: 'draft' | 'needs_revision' | 'needs_second_review' | 'approved';
  source: 'human-assisted';
  updatedAt: string;
  submittedAt?: string;
  qualityReasons: string[];
  reworkReason?: string;
  receipt?: string;
  submitter?: string;
  deliveredAt?: string;
};
export type EvidenceItem = {
  id: string;
  label: string;
  content: string;
  originalPath?: string;
  sha256?: string;
  truncated?: boolean;
};
export function blankHumanDraft(): HumanDraft {
  return {
    reviewer: '',
    verification: '',
    process: '',
    artifact: '',
    other: '',
    qualityResolution: '',
    attested: false,
    findings: Array.from({ length: 5 }, () => ({
      score: 0,
      when: '',
      behavior: '',
      impact: '',
      expected: '',
      evidenceRefs: '',
    })),
  };
}
export function humanMaterials(r: Turn, draft?: HumanDraft): EvidenceItem[] {
  return [
    { id: 'prompt', label: '实际执行需求', content: r.prompt },
    ...(r.output
      ? [
          {
            id: 'output',
            label: '模型原始回复（完成声明需实际核验）',
            content: r.output,
          },
        ]
      : []),
    ...(r.evidence || []),
    ...(draft?.verification
      ? [
          {
            id: 'verification',
            label: '本人的实际核验记录',
            content: draft.verification,
          },
        ]
      : []),
  ];
}
export function normalizeHumanDraft(raw: unknown): HumanDraft {
  if (!raw || typeof raw !== 'object') throw Error('人工评审格式无效');
  const v = raw as Record<string, unknown>;
  const str = (x: unknown, max = 1600) => {
    if (typeof x !== 'string' || x.length > max)
      throw Error('评审字段格式无效或过长');
    return x.trim();
  };
  if (!Array.isArray(v.findings) || v.findings.length !== 5)
    throw Error('需保留五个评分维度');
  return {
    reviewer: str(v.reviewer, 100),
    verification: str(v.verification, 6000),
    process: str(v.process),
    artifact: str(v.artifact),
    other: str(v.other),
    qualityResolution: str(v.qualityResolution || '', 3000),
    attested: v.attested === true,
    findings: v.findings.map((f) => {
      if (
        !f ||
        typeof f !== 'object' ||
        !Number.isInteger(f.score) ||
        f.score < 0 ||
        f.score > 5
      )
        throw Error('评分需为 1–5 分，草稿可留空');
      return {
        score: f.score,
        when: str(f.when),
        behavior: str(f.behavior),
        impact: str(f.impact),
        expected: str(f.expected),
        evidenceRefs: str(f.evidenceRefs, 1000),
      };
    }),
  };
}
export function humanDraftIssues(r: Turn, d: HumanDraft): string[] {
  const e: string[] = [];
  if (!d.reviewer) e.push('填写实际确认人');
  if (!d.verification) e.push('记录实际操作、测试及观察结果');
  if (!d.process || !d.artifact) e.push('分别填写过程与产物的核验结论');
  if (!d.attested) e.push('本人确认已实际检查并核对 AI 评分');
  const materials = humanMaterials(r, d);
  d.findings.forEach((f, i) => {
    if (f.score < 1 || f.score > 5) e.push(`第 ${i + 1} 维需填写 1–5 分`);
    if (!f.when || !f.behavior || !f.impact || !f.expected)
      e.push(`第 ${i + 1} 维缺少节点、行为、影响或正确做法`);
    const refs = f.evidenceRefs
      .split(/\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!refs.length) e.push(`第 ${i + 1} 维缺少证据引用`);
    for (const ref of refs) {
      const m = ref.match(/^([a-z0-9_-]+):(\d+)$/),
        file = m && materials.find((x) => x.id === m[1]);
      if (
        !(r.review?.evidenceVerified && r.review.evidenceRefs?.includes(ref)) &&
        (!m ||
          !file ||
          Number(m[2]) < 1 ||
          Number(m[2]) > file.content.split('\n').length)
      )
        e.push(`证据位置不存在：${ref}`);
    }
  });
  return [...new Set(e)];
}
export function humanQualityReasons(r: Turn, d: HumanDraft): string[] {
  const out: string[] = [];
  if (d.findings.some((f) => f.score <= 2))
    out.push('包含 1–2 分，需要复核事实和归因');
  if (
    r.review?.source === 'codex' &&
    d.findings.some((f, i) => Math.abs(f.score - r.review!.scores[i]) >= 2)
  )
    out.push('与独立 AI 评分有至少 2 分差异，需要复核依据');
  if (new Set(d.findings.map((f) => f.behavior + '|' + f.impact)).size < 3)
    out.push('多个维度使用相同描述，需要检查是否存在模板化评价');
  return out;
}
export function humanIssues(t: Task, r: Turn): string[] {
  const h = r.humanReview,
    e: string[] = [];
  if (r.excluded) e.push('该轮已排除');
  if (!['review', 'submitted'].includes(r.status)) e.push('该轮尚未完成执行');
  if (
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/[a-f0-9]{40}$/i.test(
      t.snapshot,
    )
  )
    e.push('缺少完整初始快照');
  if (!r.sessionId || !r.promptId || !r.tracePath || !t.harnessVersion || !t.os)
    e.push('会话、轨迹或环境记录不完整');
  if (!h) return [...e, '尚未完成人工评审'];
  e.push(...humanDraftIssues(r, h.draft));
  if (h.state !== 'approved')
    e.push(
      h.state === 'needs_second_review'
        ? '等待二次复核'
        : h.state === 'needs_revision'
          ? '等待补充或返工'
          : '人工评分尚未提交质检',
    );
  return e;
}
export function humanAsReview(h: HumanReview): Review {
  return {
    source: 'human',
    reviewer: h.draft.reviewer,
    attested: h.draft.attested,
    scores: h.draft.findings.map((f) => f.score),
    descriptions: h.draft.findings.map(
      (f) =>
        `节点：${f.when}；行为：${f.behavior}；影响：${f.impact}；正确做法：${f.expected}；证据：${f.evidenceRefs}`,
    ),
    other: `过程：${h.draft.process}\n产物：${h.draft.artifact}\n实际核验：${h.draft.verification}\n重点问题的核验：${h.draft.qualityResolution || '无'}\n${h.draft.other}`,
  };
}
export function humanLabel(r: Turn) {
  const h = r.humanReview;
  if (h?.receipt) return '人工交付已登记';
  return !h
    ? '待人工评审'
    : {
        draft: '人工草稿',
        needs_revision: '待返工',
        needs_second_review: '待二次复核',
        approved: '人工质检通过',
      }[h.state];
}

export function draftFromAI(r: Turn): HumanDraft {
  const draft = blankHumanDraft(),
    v = r.review;
  if (!v) return draft;
  draft.process = v.processFindings || '';
  draft.artifact = v.artifactFindings || '';
  draft.other = v.other || '';
  draft.findings = draft.findings.map((f, i) => ({
    ...f,
    score: v.scores[i] || 0,
    when: v.when?.[i] || '',
    behavior: v.behavior?.[i] || v.descriptions[i] || '',
    impact: v.impact?.[i] || '',
    expected: v.expected?.[i] || '',
    evidenceRefs: v.evidenceRefs?.[i] || '',
  }));
  return draft;
}
