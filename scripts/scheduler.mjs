import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resourceProfile } from '../lib/container-policy.mjs';

function loadCapacity({ cores, load }, maximum) {
  return load >= cores * 1.2
    ? Math.min(1, maximum)
    : load >= cores * 0.9
      ? Math.min(2, maximum)
      : maximum;
}

// Keep one instance per runner. Only load admission is debounced; physical
// memory, configured concurrency and Docker budgets still apply every sample.
export function createLoadAdmission({
  settleMs = 20000,
  recoverMs = 10000,
} = {}) {
  if (
    !Number.isFinite(settleMs) ||
    settleMs < 0 ||
    !Number.isFinite(recoverMs) ||
    recoverMs < 0
  )
    throw Error('负载稳定窗口无效');
  let admitted, pending, pendingSince, lastAt;
  return (metrics, maximum, now = Date.now()) => {
    if (
      !Number.isFinite(metrics.cores) ||
      metrics.cores <= 0 ||
      !Number.isFinite(metrics.load) ||
      metrics.load < 0 ||
      !Number.isInteger(maximum) ||
      maximum < 0 ||
      !Number.isFinite(now)
    )
      return 0;
    const target = loadCapacity(metrics, maximum);
    if (
      admitted === undefined ||
      metrics.load >= metrics.cores * 1.5 ||
      (lastAt !== undefined && now < lastAt)
    ) {
      admitted = target;
      pending = undefined;
    }
    // A reduced user or hardware limit must never wait for the load window.
    admitted = Math.min(admitted, maximum);
    lastAt = now;
    if (target === admitted) {
      pending = undefined;
      return admitted;
    }
    if (
      pending === undefined ||
      Math.sign(pending - admitted) !== Math.sign(target - admitted)
    ) {
      pending = target;
      pendingSince = now;
    } else {
      // Moving between two overloaded bands must not restart the clock and
      // postpone throttling forever. Apply only the band sustained throughout
      // the window, including when load improves by more than one band.
      pending =
        target < admitted
          ? Math.max(pending, target)
          : Math.min(pending, target);
    }
    const window = target < admitted ? settleMs : recoverMs;
    if (now - pendingSince >= window) {
      admitted = pending;
      pending = undefined;
    }
    return admitted;
  };
}

export function capacityFor(
  { cores, totalGB, availableGB, load },
  requested = 3,
  {
    profile = resourceProfile(),
    occupied = 0,
    loadAdmission,
    now = Date.now(),
  } = {},
) {
  const recommended = Math.max(
    1,
    Math.min(4, Math.floor(cores / 3), Math.floor((totalGB - 8) / 6)),
  );
  const hardwareLimit = Math.max(
    1,
    Math.min(4, Math.floor(cores / 2), Math.floor((totalGB - 8) / 6)),
  );
  const maximum = Math.min(hardwareLimit, requested);
  // availableGB already excludes memory used by running jobs. Add only the
  // slots for new work to occupied jobs instead of charging their budget twice.
  const memorySlots =
    Math.max(0, occupied) +
    Math.max(0, Math.floor((availableGB - 2) / profile.hostSlotGB));
  const loadSlots = loadAdmission
    ? loadAdmission({ cores, load }, maximum, now)
    : loadCapacity({ cores, load }, maximum);
  return {
    recommended,
    hardwareLimit,
    effective: Math.max(0, Math.min(maximum, memorySlots, loadSlots)),
    reason:
      memorySlots < maximum
        ? '可回收内存偏低'
        : loadSlots < maximum
          ? '系统负载较高'
          : '资源充足',
  };
}
export function resources(requested = 3, options = {}) {
  const totalGB = os.totalmem() / 2 ** 30;
  let availableGB = os.freemem() / 2 ** 30;
  if (os.platform() === 'darwin') {
    try {
      const v = execFileSync('vm_stat', [], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const page = Number(v.match(/page size of (\d+)/)?.[1] || 16384);
      availableGB =
        (['free', 'inactive', 'speculative'].reduce(
          (s, k) =>
            s +
            Number(v.match(new RegExp('Pages ' + k + ':\\s+(\\d+)'))?.[1] || 0),
          0,
        ) *
          page) /
        2 ** 30;
    } catch {}
  }
  const metrics = {
    cores: os.cpus().length,
    totalGB: Math.round(totalGB),
    availableGB: Math.round(availableGB * 10) / 10,
    load: Math.round(os.loadavg()[0] * 10) / 10,
  };
  return {
    ...metrics,
    ...capacityFor(metrics, requested, options),
    cpu: os.cpus()[0]?.model || os.arch(),
  };
}
export function fingerprint(repo, prompt) {
  return createHash('sha256')
    .update(
      repo.replace(/\/+$/, '') +
        '\n' +
        prompt
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[\s\p{P}]+/gu, ''),
    )
    .digest('hex');
}
export function supplyDecision(context, state, now = Date.now()) {
  if (!context.config.enabled) return '自动补充已暂停';
  if (!context.repos.length) return '等待配置仓库，或创建首个手动任务';
  if (context.generatedToday >= context.config.dailyLimit)
    return '已达今日补充上限';
  if (
    (context.queuedCount ?? Number(!!context.queued)) >=
    (context.candidateBuffer ?? 1)
  )
    return '合格候选缓冲已满';
  if (now < (state.nextAt || 0))
    return state.lastError
      ? '补充失败，退避等待：' + state.lastError
      : '补充冷却中';
  // Stop runaway generation when the execution service or repository keeps failing.
  const recent = context.history.filter((t) => t.autoGenerated).slice(0, 3);
  if (recent.length === 3 && recent.every((t) => t.failed))
    return '最近 3 个自动任务均失败，请处理失败任务后继续';
  return null;
}

// Generation fills at most the configured qualified candidate buffer. Resident
// failed/review containers retain their evidence and physical memory budget,
// but are not work in flight. Claiming the generated job still requires the
// runner's independent container admission check.
export function canReplenish(
  context,
  state,
  {
    capacity,
    active,
    recovering = 0,
    generating = false,
    readySources = context.repos,
    stageAvailable = false,
  },
  now = Date.now(),
) {
  if (
    !Number.isInteger(capacity) ||
    capacity <= 0 ||
    !Number.isInteger(active) ||
    active < 0 ||
    !Number.isInteger(recovering) ||
    recovering < 0 ||
    generating ||
    !readySources?.length ||
    (!stageAvailable && active + recovering >= capacity)
  )
    return false;
  return supplyDecision(context, state, now) === null;
}

export function heavyMemoryBudget(engine, profile = resourceProfile()) {
  const sample = engine?.resourceSample;
  if (!engine?.ready || !sample?.ok) return 0;
  const reserved = (sample.ownedContainers || []).reduce(
    (n, c) => n + c.memoryLimitBytes,
    0,
  );
  const external = sample.externalWorkingSetBytes;
  if (!Number.isFinite(external)) return 0;
  if (
    sample.vmObserved &&
    (sample.memAvailableBytes < profile.dockerReserveBytes + 512 * 2 ** 20 ||
      sample.pressure?.someAvg10 >= 10 ||
      sample.pressure?.fullAvg10 >= 1)
  )
    return 0;
  const bytes =
    Math.floor(
      Math.min(
        2 * 2 ** 30,
        engine.memoryBytes - reserved - external - profile.dockerReserveBytes,
      ) /
        (256 * 2 ** 20),
    ) *
    (256 * 2 ** 20);
  return bytes >= 768 * 2 ** 20 ? bytes : 0;
}
export function canStartHeavy(engine, profile = resourceProfile()) {
  return heavyMemoryBudget(engine, profile) > 0;
}
// Reserve 768 MiB for one verifier in addition to the profile's VM reserve.
export function projectCapacityWithVerifier(
  engine,
  profile = resourceProfile(),
) {
  const sample = engine?.resourceSample;
  if (
    !engine?.ready ||
    !sample?.ok ||
    !Number.isFinite(sample.externalWorkingSetBytes)
  )
    return 0;
  return Math.max(
    0,
    Math.floor(
      (engine.memoryBytes -
        sample.externalWorkingSetBytes -
        profile.dockerReserveBytes -
        768 * 2 ** 20) /
        profile.memoryBytes,
    ),
  );
}
