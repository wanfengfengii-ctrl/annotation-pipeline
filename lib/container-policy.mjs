export const legacyContainerImage =
  'adminfather/benzhi-claude-code:20260909-isolated-git';
export const previousContainerImage =
  'annotation-pipeline/claude-code:2.1.266-20260910';
export const containerImage =
  'annotation-pipeline/claude-code:2.1.266-webdeps-20260910';
export const containerClaudeVersion = '2.1.266';
export const containerNodeVersion = '22.22.1';
export const containerBaseDigest =
  'sha256:f77014d9e56cd3db2ac96627a286814cb1aa9f0b4bb807bea98a01383c9bc4d8';
export const containerImagePolicy = '2026-09-10.webdeps1';
export const containerPolicyVersion = '2026-09-09.docker1';
export const containerTraceRoot = '/home/node/.claude/projects';
export function dockerSnapshot(imageId) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || ''))
    throw Error('容器镜像摘要无效');
  return 'docker://' + containerImage + '@' + imageId;
}
export function validDockerSnapshot(value) {
  if (typeof value !== 'string') return false;
  const digest = value.split('@').at(-1);
  return (
    /^sha256:[a-f0-9]{64}$/.test(digest) &&
    [containerImage, previousContainerImage, legacyContainerImage].some(
      (image) => value === 'docker://' + image + '@' + digest,
    )
  );
}

// Local derived images have no registry RepoDigest. Their Docker content ID is
// immutable and is also the exact ID passed to docker run, not the mutable tag.
export function resolveContainerImage(image) {
  const labels = image?.Config?.Labels;
  if (
    !/^sha256:[a-f0-9]{64}$/.test(image?.Id || '') ||
    labels?.['annotation.pipeline.base-image'] !== legacyContainerImage ||
    labels?.['annotation.pipeline.base-digest'] !== containerBaseDigest ||
    labels?.['annotation.pipeline.claude-version'] !== containerClaudeVersion ||
    labels?.['annotation.pipeline.node-version'] !== containerNodeVersion ||
    labels?.['annotation.pipeline.image-policy'] !== containerImagePolicy ||
    image.Config.User !== 'node' ||
    image.Config.WorkingDir !== '/workspace' ||
    JSON.stringify(image.Config.Entrypoint) !==
      JSON.stringify(['/usr/local/bin/entrypoint.sh']) ||
    JSON.stringify(image.Config.Cmd) !== JSON.stringify(['interactive'])
  )
    throw Error('作业镜像的基础摘要、CLI版本或启动配置不符合当前版本');
  return {
    digest: image.Id,
    imageId: image.Id,
    claudeVersion: containerClaudeVersion,
    nodeVersion: containerNodeVersion,
    baseDigest: containerBaseDigest,
  };
}
const GiB = 2 ** 30;
export function resourceProfile(
  name = typeof process === 'undefined'
    ? 'standard'
    : process.env.RUNNER_RESOURCE_PROFILE || 'standard',
) {
  if (!['standard', 'lightweight'].includes(name))
    throw Error('未知执行器资源配置：' + name);
  return {
    name,
    cpus: 2,
    memoryBytes: (name === 'lightweight' ? 1.5 : 3) * GiB,
    memoryArg: name === 'lightweight' ? '1536m' : '3g',
    hostSlotGB: name === 'lightweight' ? 1.5 : 3,
    dockerReserveBytes: (name === 'lightweight' ? 1 : 2) * GiB,
  };
}
export function containerCapacity(
  engine,
  hostCapacity,
  { profile = resourceProfile(), occupied = 0 } = {},
) {
  if (!engine?.ready) return 0;
  const maximum = Math.max(
    0,
    Math.min(hostCapacity, 4, Math.floor(engine.cpus / profile.cpus)),
  );
  const hold = Math.min(maximum, Math.max(0, occupied));
  const sample = engine.resourceSample;
  // Legacy callers retain the standard static budget. Lightweight admission
  // requires a current sample; an unknown budget must never create new work.
  if (!sample)
    return profile.name === 'lightweight'
      ? hold
      : Math.max(
          0,
          Math.min(
            maximum,
            Math.floor(
              (engine.memoryBytes - profile.dockerReserveBytes) /
                profile.memoryBytes,
            ),
          ),
        );
  if (!sample.ok) return hold;
  const owned = sample.ownedContainers || [];
  const external = sample.externalWorkingSetBytes;
  if (
    !Number.isFinite(external) ||
    external < 0 ||
    owned.some(
      (c) =>
        !Number.isFinite(c.memoryLimitBytes) ||
        c.memoryLimitBytes <= 0 ||
        !Number.isFinite(c.workingSetBytes) ||
        c.workingSetBytes < 0,
    )
  )
    return hold;
  const externalGrowth =
    external > 0 ? Math.max(external * 0.25, 256 * 2 ** 20) : 0;
  const reserved = owned.reduce((sum, c) => sum + c.memoryLimitBytes, 0);
  if (
    reserved + external + externalGrowth + profile.dockerReserveBytes >
    engine.memoryBytes
  )
    return hold;
  const budgetSlots =
    owned.length +
    Math.max(
      0,
      Math.floor(
        (engine.memoryBytes -
          profile.dockerReserveBytes -
          external -
          externalGrowth -
          reserved) /
          profile.memoryBytes,
      ),
    );
  if (owned.some((c) => c.workingSetBytes >= c.memoryLimitBytes * 0.9))
    return hold;
  // A first container provides the VM observation point. Do not inspect or
  // execute commands in unrelated containers just to obtain that observation.
  if (!sample.vmObserved) return Math.min(maximum, budgetSlots, 1);
  if (
    !Number.isFinite(sample.memAvailableBytes) ||
    !Number.isFinite(sample.pressure?.someAvg10) ||
    !Number.isFinite(sample.pressure?.fullAvg10) ||
    sample.pressure.someAvg10 >= 10 ||
    sample.pressure.fullAvg10 >= 1
  )
    return hold;
  if (sample.memAvailableBytes <= profile.dockerReserveBytes + externalGrowth)
    return hold;
  const futureOwned = owned.reduce(
    (sum, c) => sum + Math.max(0, c.memoryLimitBytes - c.workingSetBytes),
    0,
  );
  // MemAvailable already excludes the VM's resident services and kernel. Keep
  // their full reserve in the static budget, but charge only its unused portion
  // against live free memory; otherwise the base VM footprint is counted twice.
  const vmResident = Math.max(
    0,
    engine.memoryBytes -
      sample.memAvailableBytes -
      external -
      owned.reduce((sum, c) => sum + c.workingSetBytes, 0),
  );
  const remainingVmReserve = Math.max(
    0,
    profile.dockerReserveBytes - vmResident,
  );
  const liveSlots =
    owned.length +
    Math.max(
      0,
      Math.floor(
        (sample.memAvailableBytes -
          remainingVmReserve -
          externalGrowth -
          futureOwned) /
          profile.memoryBytes,
      ),
    );
  // Returning a lower capacity only stops new admissions. The runner keeps all
  // existing Terminal sessions alive until their normal completion.
  return Math.max(0, Math.min(maximum, budgetSlots, liveSlots));
}
export function validateContainerRecord(value, taskId) {
  if (
    !value ||
    (value.questionId && !/^[a-f0-9-]{36}$/.test(value.questionId)) ||
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
