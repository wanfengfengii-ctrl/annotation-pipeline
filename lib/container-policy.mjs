export const containerImage =
  'adminfather/benzhi-claude-code:20260909-isolated-git';
export const containerPolicyVersion = '2026-09-09.docker1';
export const containerTraceRoot = '/home/node/.claude/projects';
export function dockerSnapshot(imageId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || ''))
    throw Error('容器镜像摘要无效');
  return 'docker://' + containerImage + '@' + imageId;
}
export function validDockerSnapshot(value) {
  return (
    typeof value === 'string' &&
    value === 'docker://' + containerImage + '@' + value.split('@').at(-1) &&
    /^sha256:[a-f0-9]{64}$/.test(value.split('@').at(-1))
  );
}
export function containerCapacity(engine, hostCapacity) {
  if (!engine?.ready) return 0;
  // Reserve 2 GiB for Docker itself; each isolated task gets 3 GiB and 2 CPUs.
  return Math.max(
    0,
    Math.min(
      hostCapacity,
      4,
      Math.floor((engine.memoryBytes / 2 ** 30 - 2) / 3),
      Math.floor(engine.cpus / 2),
    ),
  );
}
export function validateContainerRecord(value, taskId) {
  if (
    !value ||
    value.policyVersion !== containerPolicyVersion ||
    value.taskId !== taskId ||
    value.name !== 'annotation-' + taskId ||
    !['running', 'stopped', 'exported', 'removed', 'error'].includes(
      value.status,
    ) ||
    !validDockerSnapshot(value.snapshot)
  )
    throw Error('容器记录无效');
  if (
    typeof value.workDir !== 'string' ||
    !value.workDir.startsWith('/') ||
    !value.workDir.endsWith('/workspace')
  )
    throw Error('容器工作目录无效');
  return value;
}
