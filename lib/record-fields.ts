import { issues, type Task, type Turn, type Review } from './pipeline.ts';
import { humanAsReview } from './human-review.ts';
import { roundNumber } from './record-metadata.ts';
export const recordHeaders = [
  'User Prompt',
  'SessionID',
  'TurnID/PromptID',
  '当前对话轮次排序',
  '初始环境快照',
  '轨迹文件',
  '环境可复现等级',
  'Harness',
  'Harness 版本',
  '操作系统',
  '任务类型',
  '任务难度',
  '语言/框架',
  '交付完整性',
  '交付完整性 - 描述',
  '指令遵循',
  '指令遵循 - 描述',
  '任务规划',
  '任务规划 - 描述',
  '推理能力',
  '推理能力 - 描述',
  '执行能力',
  '执行能力 - 描述',
  '其他问题',
  '提交人',
  '提交时间',
  '质检结果',
  '父记录',
  '审核备注',
  '父记录 2',
] as const;
export type RecordSource = 'ai' | 'human';
export type RecordRow = {
  taskId: string;
  turnId: string;
  title: string;
  values: (string | number)[];
  source: RecordSource;
  exportCount: number;
  lastExportAt: string | null;
  eligible: boolean;
  provenance: string;
  formatVersion?: 2;
  originalFields?: {
    snapshot: string;
    tracePath: string;
    os: string;
    stack: string;
  };
};
export function recordCategory(value: string) {
  const names: Record<string, string> = {
    '0-1代码生成': '0-1代码生成',
    feature迭代: 'feature迭代',
    bug修复: 'Bug修复',
  };
  return names[value.replace(/\s+/g, '').toLowerCase()] || value;
}
export function recordOS(value: string) {
  if (/macos|mac os|darwin|linux/i.test(value)) return 'MacOS/Linux';
  if (/windows|win32/i.test(value)) return 'Windows';
  return value;
}
export const recordStack = (value: string) =>
  value
    .split(/[,，、;；\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('、');
export const snapshotLink = (value: string) =>
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[a-f0-9]{40}$/i.test(
    value,
  );
export function shanghaiDate(v?: string) {
  if (!v || isNaN(Date.parse(v))) return '';
  return new Date(Date.parse(v) + 8 * 3600000)
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '/')
    .replace('T', ' ');
}
export function recordRow(
  t: Task,
  r: Turn,
  source: RecordSource,
  exportCount = 0,
  lastExportAt: string | null = null,
): RecordRow {
  const h = r.humanReview,
    review: Review | undefined =
      source === 'human' && h ? humanAsReview(h) : r.review;
  const human = source === 'human',
    submitted = human ? h?.receipt : r.receipt;
  const quality = human
    ? h?.state === 'approved'
      ? '人工复核通过（已有 AI 评分）'
      : h?.state === 'needs_revision'
        ? '待返工'
        : '待人工复核'
    : !issues(t, r).length && r.automation?.delivery?.value?.passed
      ? 'AI 校验通过（待人工确认）'
      : '待 AI 校验';
  const originalFields = {
    snapshot: r.container?.sourceSnapshot
      ? r.container.snapshot +
        '\n代码快照：' +
        r.container.sourceSnapshot.manifestPath +
        '#sha256:' +
        r.container.sourceSnapshot.sha256
      : r.container?.scaffoldSnapshot
        ? r.container.snapshot +
          '\n骨架快照：' +
          r.container.scaffoldSnapshot.manifestPath +
          '#sha256:' +
          r.container.scaffoldSnapshot.sha256
        : r.container?.snapshot || t.snapshot || '',
    tracePath: r.tracePath || '',
    os: r.os || t.os || '',
    stack: r.stack || t.stack || '',
  };
  const base = [
    r.prompt,
    r.sessionId || '',
    r.promptId || '',
    roundNumber(t, r),
    r.container?.snapshot || t.snapshot || '',
    originalFields.tracePath.split(/[\\/]/).at(-1) || '',
    r.reproducibility || t.reproducibility || '',
    r.harness || t.harness || 'Claude Code',
    r.harnessVersion || t.harnessVersion || '',
    recordOS(originalFields.os),
    recordCategory(r.category),
    r.difficulty,
    recordStack(originalFields.stack),
  ];
  const values: (string | number)[] = [
    ...base,
    ...Array.from({ length: 5 }, (_, i) => [
      review?.scores[i] || '',
      review?.descriptions[i] || '',
    ]).flat(),
    review?.other || '',
    submitted
      ? human
        ? h?.submitter || h?.draft.reviewer || ''
        : r.submitter || ''
      : '',
    submitted ? shanghaiDate(human ? h?.deliveredAt : r.submittedAt) : '',
    quality,
    r.recordMetadata?.parentRecord || '',
    r.recordMetadata?.auditNote || '',
    r.recordMetadata?.parentRecord2 || '',
  ];
  return {
    taskId: t.id,
    turnId: r.id,
    title: t.title,
    values,
    source,
    exportCount,
    lastExportAt,
    formatVersion: 2,
    originalFields,
    eligible:
      !r.excluded &&
      (human
        ? h?.state === 'approved' &&
          !issues(t, { ...r, review: humanAsReview(h) }).length
        : !issues(t, r).length),
    provenance: human
      ? 'AI 评分 / 人工二次确认，非纯人工标注'
      : 'AI / Codex CLI，未经人工确认',
  };
}
export type RecordFilter = {
  source: RecordSource;
  query: string;
  category: string;
  day: string;
  exports: 'all' | 'never' | 'exported' | 'exact';
  count: number;
  page: number;
  pageSize: number;
};
export function recordFilter(v: Record<string, unknown>): RecordFilter {
  const number = (x: unknown, def: number, max: number) => {
    const n = x === undefined || x === '' ? def : Number(x);
    if (!Number.isInteger(n) || n < 0 || n > max)
      throw Error('分页或导出次数无效');
    return n;
  };
  const out: RecordFilter = {
    source: v.source === 'human' ? 'human' : 'ai',
    query: String(v.query || '').trim(),
    category: String(v.category || ''),
    day: String(v.day || ''),
    exports: (v.exports || 'all') as RecordFilter['exports'],
    count: number(v.count, 0, 1000000),
    page: number(v.page, 1, 1000000),
    pageSize: number(v.pageSize, 20, 100),
  };
  if (
    !['ai', 'human', undefined, ''].includes(v.source as string) ||
    !['all', 'never', 'exported', 'exact'].includes(out.exports) ||
    out.query.length > 300 ||
    out.category.length > 100 ||
    !out.page ||
    ![10, 20, 50, 100].includes(out.pageSize)
  )
    throw Error('筛选条件无效');
  if (
    out.day &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(out.day) || isNaN(Date.parse(out.day)))
  )
    throw Error('日期无效');
  return out;
}
