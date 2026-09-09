// Injectable test boundary: never launches Docker or a real model.
import { DockerRuntime } from '../../scripts/docker-runtime.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../../lib/container-policy.mjs';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
os.cpus = () => Array(10).fill({ model: 'fixture' });
os.totalmem = () => 32 * 2 ** 30;
os.freemem = () => 16 * 2 ** 30;
os.loadavg = () => [1, 1, 1];
os.platform = () => 'fixture';
DockerRuntime.prototype.ensure = async function (task) {
  let s = this.load(task.id);
  if (!s) {
    const workDir = path.join(this.root, task.id, 'workspace');
    mkdirSync(workDir, { recursive: true });
    s = {
      taskId: task.id,
      name: 'annotation-' + task.id,
      status: 'running',
      image: containerImage,
      imageId: 'sha256:' + 'a'.repeat(64),
      snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
      policyVersion: containerPolicyVersion,
      workDir,
      results: {},
    };
    this.save(s);
  }
  if (s.status !== 'running') throw Error('fixture container stopped');
  await this.publish(s);
  return s;
};
DockerRuntime.prototype.execute = async function (task, turn, reserve) {
  const s = await this.ensure(task);
  if (s.results[turn.id]) return s.results[turn.id];
  const quota = await reserve(turn.id, s.sessionId);
  if (!quota.allowed) throw Error('10 call cap');
  s.sessionId ||= 'fixture-session-' + task.id;
  appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({
      name: 'claude',
      taskId: task.id,
      turnId: turn.id,
      session: s.sessionId,
      event: 'start',
      time: Date.now(),
    }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 300));
  const count = Object.keys(s.results).length + 1;
  writeFileSync(path.join(s.workDir, '.fixture-count'), String(count));
  const project = task.projectSeries?.directory || 'project';
  mkdirSync(path.join(s.workDir, project), { recursive: true });
  writeFileSync(
    path.join(s.workDir, project, 'engine.ts'),
    '// synthetic project round ' + count + '\n',
  );
  const tracePath = path.join(this.root, task.id, turn.id + '.jsonl');
  writeFileSync(
    tracePath,
    JSON.stringify({
      type: 'user',
      uuid: 'fixture-prompt-' + turn.id,
      sessionId: s.sessionId,
      message: { content: turn.prompt },
    }) +
      '\n' +
      JSON.stringify({ type: 'system', subtype: 'turn_duration' }) +
      '\n',
  );
  const result = {
    success: true,
    workDir: s.workDir,
    sessionId: s.sessionId,
    promptId: 'fixture-prompt-' + turn.id,
    snapshot: s.snapshot,
    tracePath,
    traceExport: {
      verified: true,
      path: path.dirname(tracePath),
      files: 1,
      sha256: 'a'.repeat(64),
    },
    harness: 'Claude Code',
    harnessVersion: 'docker fixture',
    os: 'Linux fixture',
    model: 'configured-fixture',
    output: 'Synthetic result',
    executionOutcome: 'complete',
    claudeCallCount: quota.count,
    container: this.public(s),
  };
  s.results[turn.id] = result;
  this.save(s);
  appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({
      name: 'claude',
      event: 'end',
      taskId: task.id,
      time: Date.now(),
    }) + '\n',
  );
  return result;
};
DockerRuntime.prototype.close = async function (id) {
  const s = this.load(id);
  if (s) {
    s.status = 'removed';
    await this.publish(s);
  }
};
DockerRuntime.prototype.reconcile = async function (tasks, active) {
  for (const t of tasks)
    if (!active.has(t.id) && (t.closed || t.finishContainer))
      await this.close(t.id);
};
