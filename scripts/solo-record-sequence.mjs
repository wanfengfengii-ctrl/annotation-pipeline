import { recordKey, coveredRecordRounds } from './solo-records.mjs';

export function sequenceIssues(rows, headers) {
  const field = (row, label) => row.values[headers.indexOf(label)];
  const issues = new Map(),
    sessions = new Map();
  for (const row of rows.filter((r) => r.eligible)) {
    const id = field(row, 'SessionID');
    if (!sessions.has(id)) sessions.set(id, []);
    sessions.get(id).push(row);
  }
  for (const group of sessions.values()) {
    const roundRows = new Map();
    for (const row of group) {
      try {
        for (const covered of coveredRecordRounds(row, headers)) {
          if (roundRows.has(covered)) {
            issues.set(recordKey(row), '同一会话出现重复轮次');
            issues.set(
              recordKey(roundRows.get(covered)),
              '同一会话出现重复轮次',
            );
          }
          roundRows.set(covered, row);
        }
      } catch (error) {
        issues.set(recordKey(row), error.message);
      }
    }
    const first = roundRows.get(1);
    const heldFirst =
      !first &&
      rows.some((row) => {
        if (
          !row.uploadHold ||
          field(row, 'SessionID') !== field(group[0], 'SessionID')
        )
          return false;
        try {
          return coveredRecordRounds(row, headers).includes(1);
        } catch {
          return false;
        }
      });
    const consistency = [
      '初始环境快照',
      'Harness',
      'Harness 版本',
      '操作系统',
      '环境可复现等级',
    ];
    for (const [round, row] of roundRows) {
      if (!first || field(first, '任务难度') === '简单') {
        issues.set(
          recordKey(row),
          heldFirst
            ? '会话首轮已被用户禁止上传，后续轮次不能越序提交'
            : '会话缺少可提交的中等及以上难度首轮',
        );
        continue;
      }
      if (
        consistency.some(
          (label) =>
            headers.includes(label) &&
            field(first, label) !== field(row, label),
        )
      )
        issues.set(recordKey(row), '同一会话的初始快照或运行环境字段不一致');
      for (let previous = 1; previous < round; previous++)
        if (
          !roundRows.has(previous) ||
          issues.has(recordKey(roundRows.get(previous)))
        )
          issues.set(
            recordKey(row),
            '前序轮次缺失或不符合提交条件，保留原轮次待核对',
          );
    }
  }
  return issues;
}
