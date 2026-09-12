import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { finalizationFixture } from './fixtures/finalization.mjs';
import {
  verifyTerminalFinalization,
  verifyFinalizationOrderCompatibility,
  writeTerminalFinalization,
} from '../scripts/terminal-finalization.mjs';

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'finalization-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'task');
  const directory = path.join(taskDir, 'questions/question/terminal');
  mkdirSync(directory, { recursive: true });
  const terminal = {
    runId: 'run',
    statePath: path.join(directory, 'state.json'),
    launchPath: path.join(directory, 'question.command'),
  };
  const final = finalizationFixture(taskDir, terminal);
  return {
    taskDir,
    terminal,
    ...final,
    verify: () =>
      verifyTerminalFinalization({ taskDir, questionId: 'question', terminal }),
  };
}

test('finalization binds original launch, container, complete file set, manifest and removal', (t) => {
  const f = fixture(t);
  assert.equal(f.verify().commandTransport, 'original-mac-terminal');
  const original = readFileSync(f.receiptPath);
  for (const patch of [
    { runId: 'different' },
    { questionId: 'different' },
    { taskId: 'different' },
    { status: 'exported' },
    { removedAt: 'invalid' },
    { containerId: 'b'.repeat(64) },
    { manifestSha256: '0'.repeat(64) },
    { traceExport: { ...f.state.traceExport, exportKind: 'intermediate' } },
  ]) {
    writeFileSync(f.receiptPath, JSON.stringify({ ...f.receipt, ...patch }));
    assert.equal(f.verify(), null);
  }
  writeFileSync(f.receiptPath, original);
  assert.throws(
    () =>
      writeTerminalFinalization({ ...f.state, status: 'exported' }, f.taskDir),
    /尚未完成/,
  );
  const extra = path.join(f.state.traceExport.path, 'unlisted.json');
  writeFileSync(extra, '{}');
  assert.equal(f.verify(), null);
  rmSync(extra);
  assert(f.verify());
  renameSync(f.nativeFile, f.nativeFile + '.original');
  symlinkSync(f.nativeFile + '.original', f.nativeFile);
  assert.equal(f.verify(), null);
});

test('verified final legacy exports remain explicitly identified during migration', (t) => {
  const f = fixture(t);
  const oldDirectory = path.dirname(f.state.traceExport.path);
  const legacyDirectory = path.join(f.taskDir, 'final.traces-1700000000000');
  renameSync(oldDirectory, legacyDirectory);
  const legacy = {
    ...f.state,
    finalCommandTransport: undefined,
    traceExport: {
      ...f.state.traceExport,
      exportKind: undefined,
      path: path.join(legacyDirectory, 'projects'),
      manifestPath: path.join(legacyDirectory, 'manifest.json'),
    },
  };
  writeTerminalFinalization(legacy, f.taskDir);
  assert.equal(f.verify().commandTransport, 'legacy-runner-migration');
  assert.equal(
    verifyTerminalFinalization({
      taskDir: f.taskDir,
      questionId: 'question',
      terminal: { ...f.terminal, runId: 'new' },
    }),
    null,
  );
});

test('an empty unstarted question can finish cleanup, but a called session cannot use an empty export', (t) => {
  const f = fixture(t);
  rmSync(f.nativeFile);
  writeFileSync(
    f.state.traceExport.manifestPath,
    JSON.stringify({ containerId: f.state.containerId, files: [] }),
  );
  f.state.traceExport.files = 0;
  f.state.traceExport.sha256 = createHash('sha256').update('[]').digest('hex');
  writeTerminalFinalization(f.state, f.taskDir);
  assert.equal(f.verify().emptyWithoutCalls, true);
  for (const patch of [
    { sessionId: 'called' },
    { pending: { phase: 'sent' } },
    { results: { question: {} } },
  ])
    assert.throws(
      () => writeTerminalFinalization({ ...f.state, ...patch }, f.taskDir),
      /轨迹/,
    );
});

test('legacy order compatibility verifies original cp/rm while retaining the failed bridge acknowledgement', (t) => {
  const f = fixture(t),
    state = f.state,
    root = state.traceExport.path,
    hash = (b) => createHash('sha256').update(b).digest('hex');
  const extra = path.join(root, '-workspace/session/tool-results/output.txt');
  mkdirSync(path.dirname(extra), { recursive: true });
  writeFileSync(extra, 'original tool output');
  const files = [
    '-workspace/session/tool-results/output.txt',
    '-workspace/session.jsonl',
  ].map((name) => {
    const bytes = readFileSync(path.join(root, name));
    return { name, bytes: bytes.length, sha256: hash(bytes) };
  });
  writeFileSync(
    state.traceExport.manifestPath,
    JSON.stringify({ containerId: state.containerId, files }),
  );
  state.traceExport.files = files.length;
  state.traceExport.sha256 = hash(JSON.stringify(files));
  writeTerminalFinalization(state, f.taskDir);
  const terminalState = {
    runId: f.terminal.runId,
    containerId: state.containerId,
    status: 'postprocessing',
    realTerminal: true,
    exitCode: 0,
    childPid: 123,
    tty: '/dev/ttys007',
  };
  writeFileSync(f.terminal.statePath, JSON.stringify(terminalState));
  const ops = path.join(path.dirname(f.terminal.statePath), 'operations');
  mkdirSync(ops);
  const error =
    '[postprocessing retained] Verified export and original-container removal must finish before closing';
  const record = (action, values, request = {}) => ({
    runId: f.terminal.runId,
    tty: terminalState.tty,
    request: {
      runId: f.terminal.runId,
      containerId: state.containerId,
      action,
      ...request,
    },
    result: {
      runId: f.terminal.runId,
      action,
      status: 'succeeded',
      exitCode: 0,
      ...values,
    },
  });
  const cp = record(
    'cp',
    { manifest: files },
    { destination: state.traceExport.path },
  );
  const rm = record('rm', { removed: true });
  const complete = record('complete', {
    status: 'failed',
    operationId: 'complete-one',
    error,
  });
  writeFileSync(path.join(ops, 'cp.json'), JSON.stringify(cp));
  writeFileSync(path.join(ops, 'rm.json'), JSON.stringify(rm));
  writeFileSync(path.join(ops, 'complete.json'), JSON.stringify(complete));
  const input = {
    taskDir: f.taskDir,
    questionId: 'question',
    terminal: f.terminal,
    result: complete.result,
    isChildAlive: () => false,
  };
  const before = readFileSync(f.nativeFile),
    ack = readFileSync(path.join(ops, 'complete.json'));
  const proof = verifyFinalizationOrderCompatibility(input);
  assert.equal(proof.source, 'verified-original-mac-terminal-operations');
  assert.equal(proof.terminalWindowPending, true);
  assert.deepEqual(readFileSync(f.nativeFile), before);
  assert.deepEqual(readFileSync(path.join(ops, 'complete.json')), ack);
  assert.equal(
    verifyFinalizationOrderCompatibility({
      ...input,
      isChildAlive: () => true,
    }),
    null,
  );
  assert.equal(
    verifyFinalizationOrderCompatibility({
      ...input,
      result: { ...complete.result, error: 'different failure' },
    }),
    null,
  );
  for (const replacement of [
    { ...cp, runId: 'other' },
    { ...cp, result: { ...cp.result, manifest: [] } },
  ]) {
    writeFileSync(path.join(ops, 'cp.json'), JSON.stringify(replacement));
    assert.equal(verifyFinalizationOrderCompatibility(input), null);
  }
  writeFileSync(path.join(ops, 'cp.json'), JSON.stringify(cp));
  rmSync(path.join(ops, 'rm.json'));
  assert.equal(verifyFinalizationOrderCompatibility(input), null);
  writeFileSync(path.join(ops, 'rm.json'), JSON.stringify(rm));
  writeFileSync(extra, 'changed');
  assert.equal(verifyFinalizationOrderCompatibility(input), null);
});
