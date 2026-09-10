import { terminalProtocolVersion } from './mac-terminal.mjs';

// Container ownership stays with one runner. Claim and cleanup exclude each
// other's task IDs before any asynchronous operation begins.
export class FinalizationQueue {
  constructor({
    runtime,
    refresh,
    onError = () => {},
    onComplete = () => {},
    now = () => Date.now(),
  }) {
    Object.assign(this, { runtime, refresh, onError, onComplete, now });
    this.active = new Map();
    this.retryAt = new Map();
    this.completed = new Map();
  }
  enqueue(tasks, busy) {
    if (this.active.size) return;
    for (const task of tasks) {
      const plan = task.finalization;
      if (
        !plan ||
        this.completed.get(task.id) === JSON.stringify(plan) ||
        busy.has(task.id) ||
        this.active.has(task.id) ||
        this.now() < (this.retryAt.get(task.id) || 0)
      )
        continue;
      const state = this.runtime.load(task.id);
      if (
        !state ||
        state.pending ||
        (state.status !== 'removed' &&
          state.terminal?.terminalProtocolVersion !== terminalProtocolVersion)
      )
        continue;
      // Defer execution to the next microtask so the task lock is visible first.
      const promise = Promise.resolve()
        .then(async () => {
          const assertCurrent = async () => {
            const current = (await this.refresh()).find(
              (t) => t.id === task.id,
            );
            if (JSON.stringify(current?.finalization) !== JSON.stringify(plan))
              throw Error('会话收尾条件已变化，保留容器');
          };
          await assertCurrent();
          await this.runtime.close(task.id, {
            failedTurnId: plan.failedTurnId,
            beforeExit: assertCurrent,
          });
          this.completed.set(task.id, JSON.stringify(plan));
          await this.onComplete(task.id, this.runtime.load(task.id));
        })
        .catch((error) => {
          this.retryAt.set(task.id, this.now() + 60000);
          this.onError({ taskId: task.id, reason: error.message });
        })
        .finally(() => this.active.delete(task.id));
      this.active.set(task.id, promise);
      // One export at a time avoids disk/Terminal contention, independent of jobs.
      break;
    }
  }
}
