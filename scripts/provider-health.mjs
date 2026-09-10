import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
// Admission circuit uses real results only. A timeout never resends a prompt.
export class ProviderHealth {
  constructor({ now = () => Date.now(), pauseMs = 300000, file } = {}) {
    this.now = now;
    this.pauseMs = pauseMs;
    this.failures = new Map();
    this.pausedUntil = 0;
    this.probeTaskId = null;
    this.file = file;
    if (file && existsSync(file)) {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      this.failures = new Map(value.failures || []);
      this.pausedUntil = Number(value.pausedUntil) || 0;
      this.probeTaskId = value.probeTaskId || null;
    }
  }
  save() {
    if (!this.file) return;
    writeFileSync(
      this.file + '.tmp',
      JSON.stringify({
        failures: [...this.failures],
        pausedUntil: this.pausedUntil,
        probeTaskId: this.probeTaskId,
      }),
      { mode: 0o600 },
    );
    renameSync(this.file + '.tmp', this.file);
  }
  reconcile(runningTaskIds) {
    if (
      Array.isArray(runningTaskIds) &&
      this.probeTaskId &&
      !runningTaskIds.includes(this.probeTaskId)
    ) {
      this.probeTaskId = null;
      this.save();
    }
  }
  observe(taskId, result) {
    if (result.executionOutcome === 'complete' && result.promptId) {
      this.failures.delete(taskId);
      if (this.probeTaskId === taskId) {
        this.pausedUntil = 0;
        this.failures.clear();
      }
      if (this.probeTaskId === taskId) this.probeTaskId = null;
    } else if (
      result.executionOutcome === 'error' &&
      result.promptId &&
      result.permissionAudit?.passed !== false
    ) {
      this.failures.set(taskId, this.now());
      for (const [id, at] of this.failures)
        if (this.now() - at > 600000) this.failures.delete(id);
      if (this.failures.size >= 2 || this.probeTaskId === taskId)
        this.pausedUntil = this.now() + this.pauseMs;
      if (this.probeTaskId === taskId) this.probeTaskId = null;
    }
  }
  release(taskId) {
    if (this.probeTaskId === taskId) this.probeTaskId = null;
    this.save();
  }
  canAdmit() {
    return !this.probeTaskId && this.now() >= this.pausedUntil;
  }
  admit(taskId) {
    if (this.pausedUntil) this.probeTaskId = taskId;
    this.save();
  }
  snapshot() {
    return {
      pausedUntil: this.pausedUntil
        ? new Date(this.pausedUntil).toISOString()
        : null,
      probeTaskId: this.probeTaskId,
      failedProjects: this.failures.size,
    };
  }
}
