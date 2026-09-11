// One budget owned by the runner, shared by every immutable job release.
// A waiting stage never keeps a lease. Running work is never preempted.
export const stageLimits = Object.freeze({ claude: 3, codex: 3, heavy: 3 });
const MiB = 2 ** 20;
export class StageBudget {
  constructor({ capacity = 1, stopped = () => false } = {}) {
    this.capacity = capacity;
    this.heavyAllowed = true;
    this.heavyMemoryPoolBytes = Infinity;
    this.stopped = stopped;
    this.running = new Map();
    this.waiting = [];
    this.sequence = 0;
  }
  update(
    capacity,
    {
      heavyAllowed = true,
      heavyMemoryPoolBytes = this.heavyMemoryPoolBytes,
    } = {},
  ) {
    this.heavyAllowed = heavyAllowed;
    if (!(heavyMemoryPoolBytes >= 0)) throw Error('验收共享内存预算无效');
    this.heavyMemoryPoolBytes = heavyMemoryPoolBytes;
    const slots = Math.max(
      1,
      Math.min(
        stageLimits.heavy,
        Math.floor(heavyMemoryPoolBytes / (768 * MiB)),
      ),
    );
    this.heavyMemoryBytes = Number.isFinite(heavyMemoryPoolBytes)
      ? Math.min(
          2048 * MiB,
          Math.floor(heavyMemoryPoolBytes / slots / (256 * MiB)) * 256 * MiB,
        )
      : undefined;
    this.capacity = Math.max(0, Math.min(3, capacity));
    this.pump();
  }
  snapshot() {
    return {
      capacity: this.capacity,
      running: [...this.running.values()],
      waiting: this.waiting.map(({ kind, taskId, stage, queuedAt }) => ({
        kind,
        taskId,
        stage,
        queuedAt,
      })),
      limits: stageLimits,
      heavyMemoryPoolBytes: Number.isFinite(this.heavyMemoryPoolBytes)
        ? this.heavyMemoryPoolBytes
        : null,
      heavyReservedBytes: [...this.running.values()].reduce(
        (n, r) => n + (r.memoryBytes || 0),
        0,
      ),
    };
  }
  pump() {
    if (this.stopped()) {
      for (const item of this.waiting.splice(0))
        item.reject(Error('执行器正在停止'));
      return;
    }
    this.waiting.sort((a, b) => b.priority - a.priority || a.order - b.order);
    for (const item of this.waiting.slice()) {
      const same = [...this.running.values()].filter(
        (r) => r.kind === item.kind,
      ).length;
      const needsMemory =
        item.kind === 'heavy' && item.stage !== 'environment-ready';
      const memoryBytes = needsMemory ? this.heavyMemoryBytes : undefined;
      const reserved = [...this.running.values()].reduce(
        (n, r) => n + (r.memoryBytes || 0),
        0,
      );
      if (
        (item.kind === 'heavy' &&
          item.stage !== 'environment-ready' &&
          !this.heavyAllowed) ||
        this.running.size >= this.capacity ||
        same >= stageLimits[item.kind] ||
        (needsMemory &&
          Number.isFinite(this.heavyMemoryPoolBytes) &&
          (memoryBytes < 768 * MiB ||
            reserved + memoryBytes > this.heavyMemoryPoolBytes))
      )
        continue;
      this.waiting.splice(this.waiting.indexOf(item), 1);
      this.running.set(item.order, {
        kind: item.kind,
        taskId: item.taskId,
        stage: item.stage,
        startedAt: new Date().toISOString(),
        ...(memoryBytes ? { memoryBytes } : {}),
      });
      const release = () => {
        this.running.delete(item.order);
        this.pump();
      };
      release.memoryBytes = memoryBytes;
      item.resolve(release);
    }
  }
  async run(kind, taskId, stage, work, { onWait, onStart } = {}) {
    if (!['claude', 'codex', 'heavy'].includes(kind))
      throw Error('阶段资源类型无效');
    onWait?.();
    const release = await new Promise((resolve, reject) => {
      this.waiting.push({
        kind,
        taskId,
        stage,
        resolve,
        reject,
        order: ++this.sequence,
        priority: /score|delivery|next|runtime|final/.test(stage)
          ? 2
          : stage === 'generate'
            ? 0
            : 1,
        queuedAt: new Date().toISOString(),
      });
      this.pump();
    });
    try {
      onStart?.();
      return await work({ memoryBytes: release.memoryBytes });
    } finally {
      release();
    }
  }
}
