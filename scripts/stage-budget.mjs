// One budget owned by the runner, shared by every immutable job release.
// A waiting stage never keeps a lease. Running work is never preempted.
export class StageBudget {
  constructor({ capacity = 1, stopped = () => false } = {}) {
    this.capacity = capacity;
    this.heavyAllowed = true;
    this.stopped = stopped;
    this.running = new Map();
    this.waiting = [];
    this.sequence = 0;
  }
  update(capacity, { heavyAllowed = true } = {}) {
    this.heavyAllowed = heavyAllowed;
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
      limits: { claude: 3, codex: 1, heavy: 1 },
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
      if (
        (item.kind === 'heavy' && !this.heavyAllowed) ||
        this.running.size >= this.capacity ||
        same >= (item.kind === 'claude' ? 3 : 1)
      )
        continue;
      this.waiting.splice(this.waiting.indexOf(item), 1);
      this.running.set(item.order, {
        kind: item.kind,
        taskId: item.taskId,
        stage: item.stage,
        startedAt: new Date().toISOString(),
      });
      item.resolve(() => {
        this.running.delete(item.order);
        this.pump();
      });
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
      return await work();
    } finally {
      release();
    }
  }
}
