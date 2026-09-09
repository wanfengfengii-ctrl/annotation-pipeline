import type { Task, Turn } from './pipeline.ts';
export type RecordMetadata = {
  parentRecord: string;
  auditNote: string;
  parentRecord2: string;
};
export function roundNumber(t: Task, r: Turn): number | '' {
  if (r.questionRootId) {
    const index = t.turns?.findIndex((x) => x.id === r.id) ?? -1;
    if (index >= 0)
      return t.turns
        .slice(0, index + 1)
        .filter((x) => x.questionRootId === r.questionRootId).length;
  }
  if (
    Number.isInteger(r.roundNumber) &&
    r.roundNumber! >= 1 &&
    r.roundNumber! <= 10
  )
    return r.roundNumber!;
  const index = t.turns?.findIndex((x) => x.id === r.id) ?? -1;
  return index >= 0 ? index + 1 : '';
}
export function updateRecordMetadata(t: Task, r: Turn, input: unknown) {
  if (
    !['review', 'failed'].includes(r.status) ||
    r.receipt ||
    r.humanReview?.receipt
  )
    throw Error('该轮正在执行或已登记交付，不能修改审核字段');
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('审核字段格式无效');
  const v = input as Record<string, unknown>;
  const next: RecordMetadata = {
    parentRecord: '',
    auditNote: '',
    parentRecord2: '',
  };
  for (const key of Object.keys(next) as (keyof RecordMetadata)[]) {
    if (
      typeof v[key] !== 'string' ||
      v[key].length > (key === 'auditNote' ? 5000 : 2000)
    )
      throw Error('审核字段内容无效或超出长度限制');
    next[key] = v[key].trim();
  }
  const previous = r.recordMetadata || {
    parentRecord: '',
    auditNote: '',
    parentRecord2: '',
  };
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  if ((r.metadataHistory?.length || 0) >= 100)
    throw Error('该轮审核字段已修改 100 次，请保留历史记录后另行处理');
  const at = new Date().toISOString();
  r.recordMetadata = next;
  r.metadataHistory = [
    ...(r.metadataHistory || []),
    { at, previous, value: next },
  ];
  r.roundNumber = roundNumber(t, r) || undefined;
}
