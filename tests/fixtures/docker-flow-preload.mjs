// Injectable test boundary: never launches Docker or a real model.
import { questionRoot } from '../../lib/question-session.mjs';
import { permissionAuditVersion } from '../../lib/permission-audit.mjs';
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
DockerRuntime.prototype.ensure = async function (task, turn) {
  let s = this.load(task.id);
  const questionId = questionRoot(task, turn);
  if (s && s.questionId !== questionId) {
    await this.close(task.id);
    s = null;
  }
  if (!s) {
    const workDir = path.join(
      this.root,
      task.id,
      'questions',
      questionId,
      'workspace',
    );
    mkdirSync(workDir, { recursive: true });
    s = {
      terminalIdentity: {
        transport: 'mac-terminal',
        runId: questionId,
        realTerminal: true,
        tty: '/dev/fixture',
      },
      bootstrapped: true,
      taskId: task.id,
      questionId,
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
  this.importPriorQuestion(s, task, turn);
  await this.publish(s);
  return s;
};
DockerRuntime.prototype.execute = async function (task, turn, reserve) {
  const s = await this.ensure(task, turn);
  if (s.results[turn.id]) return s.results[turn.id];
  const quota = await reserve(turn.id, s.sessionId);
  if (!quota.allowed) throw Error('10 call cap');
  s.sessionId ||= 'fixture-session-' + s.questionId;
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
  const count = task.turns.findIndex((r) => r.id === turn.id) + 1;
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
    permissionAudit: {
      version: permissionAuditVersion,
      passed: true,
      modeVerified: true,
      mode: 'bypassPermissions',
      denialCount: 0,
      findings: [],
      tools: [],
      toolCalls: 0,
      traceSha256: 'a'.repeat(64),
    },
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
DockerRuntime.prototype.environmentEvidence = function (task, turn) {
  const s = this.load(task.id);
  if (!s || s.questionId !== questionRoot(task, turn) || s.status !== 'running')
    throw Error('fixture environment unavailable');
  return {
    source: 'synthetic fixture',
    taskId: task.id,
    questionId: s.questionId,
    containerId: s.questionId,
    imageId: s.imageId,
    snapshot: s.snapshot,
    workDir: s.workDir,
    mount: { source: s.workDir, destination: '/workspace', writable: true },
    isolationVerified: true,
    permissionPreflight: { passed: true },
    terminalIdentity: s.terminalIdentity,
    running: true,
  };
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
