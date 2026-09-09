export const initialCodeVersion = '2026-09-10.initial-code1';
export function initialSnapshotSubject(container) {
  const value = container?.sourceSnapshot || container?.scaffoldSnapshot;
  if (!value?.manifestPath || !/^[a-f0-9]{64}$/.test(value.sha256 || ''))
    throw Error('缺少执行前冻结的初始代码清单，不能用当前产物代替初始快照');
  return { ...value, kind: container.sourceSnapshot ? 'source' : 'scaffold' };
}
export function validateInitialCodeSnapshot(
  value,
  taskId,
  questionId,
  container,
) {
  const subject = initialSnapshotSubject(container);
  if (
    !value ||
    value.version !== initialCodeVersion ||
    value.engine !== 'github-cli-initial-code' ||
    value.taskId !== taskId ||
    value.questionId !== questionId ||
    value.manifestSha256 !== subject.sha256 ||
    value.imageSnapshot !== container.snapshot ||
    !/^[a-f0-9]{40}$/.test(value.sha || '') ||
    !/^[a-f0-9]{40}$/.test(value.tree || '') ||
    !/^[\w.-]+\/[\w.-]+$/.test(value.repository || '') ||
    value.url !==
      `https://github.com/${value.repository}/commit/${value.sha}` ||
    value.isPrivate !== true ||
    !Number.isInteger(value.files) ||
    value.files < 1 ||
    !['before-run', 'backfill'].includes(value.publicationMode) ||
    !value.verifiedAt ||
    !Number.isFinite(Date.parse(value.verifiedAt))
  )
    throw Error('初始代码 GitHub 快照与本题冻结清单不一致');
  return value;
}
