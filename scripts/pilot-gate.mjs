import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// Optional one-project rollout, enabled by the operator only for this release.
// It opens automatically after verified native finalization of the pilot chain.
export class PilotGate {
  constructor(workRoot) {
    this.file = path.join(workRoot, 'throughput-pilot.json');
  }
  read() {
    return existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : null;
  }
  save(value) {
    writeFileSync(this.file + '.tmp', JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
    renameSync(this.file + '.tmp', this.file);
  }
  capacity(requested) {
    const s = this.read();
    return s?.status === 'pilot' ? Math.min(1, requested) : requested;
  }
  admit(taskId, questionId) {
    const s = this.read();
    if (s?.status === 'pilot' && !s.taskId) {
      s.taskId = taskId;
      s.questionId = questionId;
      this.save(s);
    }
  }
  finalized(taskId, state) {
    const s = this.read();
    if (
      s?.status !== 'pilot' ||
      s.taskId !== taskId ||
      s.questionId !== state.questionId
    )
      return;
    const results = Object.values(state.results || {});
    if (
      state.status === 'removed' &&
      state.traceExport?.verified &&
      state.finalCommandTransport === 'original-mac-terminal' &&
      state.permissionAudit?.passed === true &&
      results.length > 0 &&
      results.every((r) => r.success === true)
    ) {
      s.status = 'expanded';
      s.completedAt = new Date().toISOString();
      s.traceExportSha256 = state.traceExport.sha256;
      this.save(s);
    }
  }
}
