import { terminalProtocolVersion } from './mac-terminal.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { conditionDigest } from '../lib/recovery-conditions.mjs';
import { failureKind } from '../lib/retry-policy.mjs';
const implementationRevision = conditionDigest(
  [
    './finalization-queue.mjs',
    './docker-runtime.mjs',
    './mac-terminal.mjs',
    './terminal-finalization.mjs',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')),
);

const read = (file) => {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
export function finalizationConditions(plan, state, revision) {
  const receiptRead = (file) => {
    try {
      return read(file);
    } catch (e) {
      return { readError: e.message };
    }
  };
  const terminal = receiptRead(state?.terminal?.statePath);
  const receipt = state?.terminal?.statePath
    ? receiptRead(
        path.join(path.dirname(state.terminal.statePath), 'finalization.json'),
      )
    : null;
  return conditionDigest({
    plan,
    revision,
    container: [
      state?.containerId,
      state?.questionId,
      state?.status,
      state?.sessionId,
      state?.pending,
      state?.traceExport?.sha256,
      state?.terminal?.runId,
      state?.terminalFinalization?.completedAt,
    ],
    terminal: terminal && [
      terminal.runId,
      terminal.status,
      terminal.containerId,
      terminal.exitCode,
      terminal.readError,
    ],
    receipt,
  });
}

// Container ownership stays with one runner. Claim and cleanup exclude each
// other's task IDs before any asynchronous operation begins.
export class FinalizationQueue {
  constructor({
    runtime,
    refresh,
    onError = () => {},
    onComplete = () => {},
    now = () => Date.now(),
    stateFile = runtime.root
      ? path.join(runtime.root, 'finalization-queue.json')
      : null,
    revision = implementationRevision,
  }) {
    Object.assign(this, {
      runtime,
      refresh,
      onError,
      onComplete,
      now,
      stateFile,
      revision,
    });
    this.active = new Map();
    this.retryAt = new Map();
    this.completed = new Map();
    this.failures = read(stateFile) || {};
  }
  persist() {
    if (!this.stateFile) return;
    const tmp = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.failures), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
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
      const legacy =
        state?.status !== 'removed' &&
        state?.terminal?.terminalProtocolVersion !== terminalProtocolVersion;
      if (!state || state.pending || (legacy && !plan.failedTurnId)) continue;
      let conditionsKey;
      try {
        conditionsKey = finalizationConditions(plan, state, this.revision);
      } catch (error) {
        this.onError({ taskId: task.id, reason: error.message });
        continue;
      }
      const previous = this.failures[task.id];
      if (
        previous?.conditionsKey === conditionsKey &&
        (previous.waitForChange || this.now() < previous.retryAt)
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
            const owned = this.runtime.load(task.id);
            if (
              (plan.questionId && owned?.questionId !== plan.questionId) ||
              (plan.containerId && owned?.containerId !== plan.containerId)
            )
              throw Error('会话收尾与当前容器身份不一致，保留容器');
          };
          await assertCurrent();
          const operation = legacy ? 'parkCompleted' : 'close';
          await this.runtime[operation](task.id, {
            failedTurnId: plan.failedTurnId,
            beforeExit: assertCurrent,
          });
          await this.onComplete(task.id, this.runtime.load(task.id));
          this.completed.set(task.id, JSON.stringify(plan));
          delete this.failures[task.id];
          this.persist();
        })
        .catch((error) => {
          this.retryAt.set(task.id, this.now() + 60000);
          const after = finalizationConditions(
            plan,
            this.runtime.load(task.id),
            this.revision,
          );
          const attempts =
            previous?.conditionsKey === after ? previous.attempts + 1 : 1;
          const waitForChange =
            failureKind(error.message) !== 'transport' || attempts >= 2;
          this.failures[task.id] = {
            plan,
            conditionsKey: after,
            attempts,
            waitForChange,
            reason: error.message,
            checkedAt: new Date(this.now()).toISOString(),
            retryAt: this.now() + 60000,
          };
          this.persist();
          this.onError({
            taskId: task.id,
            reason: error.message,
            waitForChange,
          });
        })
        .finally(() => this.active.delete(task.id));
      this.active.set(task.id, promise);
      // One export at a time avoids disk/Terminal contention, independent of jobs.
      break;
    }
  }
}
