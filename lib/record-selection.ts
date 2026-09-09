export type RecordIdentity = { taskId: string; turnId: string };
export type ExportScope = 'page' | 'filtered' | 'selected';
export const recordKey = (r: RecordIdentity) => `${r.taskId}:${r.turnId}`;
export function exportScope(value: unknown): ExportScope {
  if (value === undefined) return 'filtered';
  if (value !== 'page' && value !== 'filtered' && value !== 'selected')
    throw Error('导出范围无效');
  return value;
}
export function recordSelection(value: unknown): RecordIdentity[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw Error('请勾选 1 至 1000 条记录');
  const keys = new Set<string>();
  const rows = value.map((v: unknown) => {
    if (!v || typeof v !== 'object') throw Error('勾选记录标识无效');
    const { taskId, turnId } = v as RecordIdentity;
    if (
      [taskId, turnId].some(
        (x) => typeof x !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x),
      )
    )
      throw Error('勾选记录标识无效');
    const row = { taskId, turnId },
      key = recordKey(row);
    if (keys.has(key)) throw Error('勾选记录重复');
    keys.add(key);
    return row;
  });
  return rows.sort((a, b) => recordKey(a).localeCompare(recordKey(b)));
}
