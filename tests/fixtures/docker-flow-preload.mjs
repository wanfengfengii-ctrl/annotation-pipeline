import { terminalProtocolVersion } from '../../scripts/mac-terminal.mjs';
// Injectable test boundary: never launches Docker or a real model.
import { questionRoot } from '../../lib/question-session.mjs';
import { auditPermissionTraces } from '../../lib/permission-audit.mjs';
import { DockerRuntime } from '../../scripts/docker-runtime.mjs';
import { evidenceInventory } from '../../scripts/evidence.mjs';
import { writeTerminalFinalization } from '../../scripts/terminal-finalization.mjs';
import {
  runtimeBrowserCache,
  browserCacheMount,
} from '../../scripts/runtime-browser-cache.mjs';
import { InitialCodePublisher } from '../../scripts/initial-code-snapshot.mjs';
import {
  initialCodeVersion,
  initialSnapshotSubject,
} from '../../lib/initial-code-snapshot.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../../lib/container-policy.mjs';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  cpSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
// Keep production CLI settings out of the synthetic end-to-end fixture.
os.homedir = () => path.join(process.env.FIXTURE_BIN, '..', 'home');
runtimeBrowserCache.ensure = async ({ imageId, cacheRoot }) => {
  const root = path.join(cacheRoot, 'fixture-browser-tools');
  mkdirSync(root, { recursive: true });
  const manifestPath = path.join(root, 'ready.json');
  const logPath = path.join(root, 'build.log');
  const manifest = JSON.stringify({
    source: 'fixture',
    imageId,
    toolVersion: '1.55.0',
  });
  const log = 'synthetic browser cache preparation\n';
  writeFileSync(manifestPath, manifest);
  writeFileSync(logPath, log);
  return {
    root,
    imageId,
    platform: 'linux/arm64',
    toolVersion: '1.55.0',
    manifestPath,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    preparation: {
      logPath,
      logSha256: createHash('sha256').update(log).digest('hex'),
    },
    mountPath: browserCacheMount,
    modulePath: browserCacheMount + '/tools/node_modules/playwright',
    browsersPath: browserCacheMount + '/browsers',
  };
};
os.cpus = () => Array(10).fill({ model: 'fixture' });
os.totalmem = () => 32 * 2 ** 30;
os.freemem = () => 16 * 2 ** 30;
os.loadavg = () => [1, 1, 1];
os.platform = () => 'fixture';
InitialCodePublisher.prototype.publish = function ({
  taskId,
  questionId,
  container,
  publicationMode,
}) {
  const subject = initialSnapshotSubject(container);
  appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({
      name: 'initial-code',
      taskId,
      questionId,
      time: Date.now(),
    }) + '\n',
  );
  return {
    version: initialCodeVersion,
    engine: 'github-cli-initial-code',
    taskId,
    questionId,
    repository: 'fixture/initial-code',
    sha: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    url: 'https://github.com/fixture/initial-code/commit/' + 'a'.repeat(40),
    isPrivate: true,
    files: subject.files,
    manifestSha256: subject.sha256,
    imageSnapshot: container.snapshot,
    publicationMode,
    verifiedAt: new Date().toISOString(),
  };
};
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
    const terminalDirectory = path.join(path.dirname(workDir), 'terminal');
    mkdirSync(terminalDirectory, { recursive: true });
    const terminal = {
      terminalProtocolVersion,
      runId: 'fixture-terminal-' + questionId,
      statePath: path.join(terminalDirectory, 'state.json'),
      launchPath: path.join(terminalDirectory, 'question.command'),
    };
    writeFileSync(
      path.join(terminalDirectory, 'launch.json'),
      JSON.stringify(terminal),
    );
    writeFileSync(terminal.launchPath, '# synthetic terminal launch\n');
    writeFileSync(
      terminal.statePath,
      JSON.stringify({ runId: terminal.runId, status: 'running' }),
    );
    s = {
      terminal,
      terminalIdentity: {
        transport: 'mac-terminal',
        runId: terminal.runId,
        realTerminal: true,
        tty: '/dev/fixture',
      },
      bootstrapped: true,
      taskId: task.id,
      questionId,
      containerId: questionId.replaceAll('-', '').repeat(2),
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
  await new Promise((r) =>
    setTimeout(r, Number(process.env.FIXTURE_CLAUDE_DELAY_MS || 300)),
  );
  const count = task.turns.findIndex((r) => r.id === turn.id) + 1;
  writeFileSync(path.join(s.workDir, '.fixture-count'), String(count));
  const project = task.projectSeries?.directory || 'project';
  mkdirSync(path.join(s.workDir, project), { recursive: true });
  writeFileSync(
    path.join(s.workDir, project, 'engine.ts'),
    '// synthetic project round ' + count + '\n',
  );
  const tracePath = path.join(this.root, task.id, turn.id + '.jsonl');
  const traceContent =
    JSON.stringify({
      type: 'user',
      uuid: 'fixture-prompt-' + turn.id,
      sessionId: s.sessionId,
      message: { content: turn.prompt },
    }) +
    '\n' +
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }) +
    '\n';
  writeFileSync(tracePath, traceContent);
  const exportRoot = path.join(this.root, task.id, turn.id + '.export');
  const projectsRoot = path.join(exportRoot, 'projects');
  const mainName = '-workspace/' + s.sessionId + '.jsonl';
  const previous = Object.values(s.results).at(-1);
  const mainContent =
    (previous
      ? readFileSync(path.join(previous.traceExport.path, mainName), 'utf8')
      : JSON.stringify({
          type: 'permission-mode',
          permissionMode: 'bypassPermissions',
          sessionId: s.sessionId,
        }) + '\n') + traceContent;
  const nativeFiles = [
    { name: mainName, content: mainContent },
    {
      name: '-workspace/' + s.sessionId + '/subagents/fixture-helper.jsonl',
      content:
        JSON.stringify({
          type: 'system',
          subtype: 'fixture-helper',
          sessionId: 'fixture-helper-' + s.questionId,
          parentSessionId: s.sessionId,
          round: count,
        }) + '\n',
    },
  ].sort((a, b) => a.name.localeCompare(b.name));
  const files = nativeFiles.map(({ name, content }) => {
    const file = path.join(projectsRoot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, { flag: 'wx' });
    return {
      name,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  mkdirSync(path.join(projectsRoot, '-workspace/empty'), { recursive: true });
  const manifestPath = path.join(exportRoot, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ containerId: s.containerId, files }, null, 2),
    { flag: 'wx' },
  );
  writeFileSync(
    path.join(this.root, task.id, turn.id + '.native.jsonl'),
    mainContent,
  );
  const traceExport = {
    verified: true,
    path: projectsRoot,
    manifestPath,
    files: files.length,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    exportedAt: new Date().toISOString(),
  };
  const result = {
    permissionAudit: {
      ...auditPermissionTraces(nativeFiles),
      traceSha256: traceExport.sha256,
    },
    success: true,
    finishedAt: new Date().toISOString(),
    workDir: s.workDir,
    sessionId: s.sessionId,
    promptId: 'fixture-prompt-' + turn.id,
    snapshot: s.snapshot,
    tracePath,
    traceExport,
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
  if (s && s.status !== 'removed') {
    const taskDir = path.join(this.root, id);
    const root = path.join(
      taskDir,
      s.questionId + '.final.traces-fixture',
      'projects',
    );
    const latest = Object.values(s.results).at(-1);
    if (latest) {
      cpSync(latest.traceExport.path, root, { recursive: true });
      writeFileSync(
        path.join(root, '-workspace/final-cleanup.jsonl'),
        JSON.stringify({
          type: 'system',
          subtype: 'fixture-final-cleanup',
          sessionId: s.sessionId,
        }) + '\n',
      );
    } else mkdirSync(root, { recursive: true });
    const { files } = evidenceInventory(root);
    const manifestPath = path.join(path.dirname(root), 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ containerId: s.containerId, files }),
      { flag: 'wx' },
    );
    s.traceExport = {
      verified: true,
      path: root,
      manifestPath,
      files: files.length,
      sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      exportKind: 'final',
      commandTransport: 'original-mac-terminal',
    };
    s.finalCommandTransport = 'original-mac-terminal';
    s.status = 'removed';
    s.finishedAt = new Date().toISOString();
    writeTerminalFinalization(s, taskDir);
    writeFileSync(
      s.terminal.statePath,
      JSON.stringify({
        runId: s.terminal.runId,
        containerId: s.containerId,
        status: 'exited',
        postprocessingComplete: true,
        verifiedExport: true,
        containerRemoved: true,
      }),
    );
    await this.publish(s);
  }
  if (s) await this.onFinalized(s);
};
DockerRuntime.prototype.reconcile = async function (tasks, active) {
  for (const t of tasks)
    if (!active.has(t.id) && (t.closed || t.finishContainer))
      await this.close(t.id);
};
