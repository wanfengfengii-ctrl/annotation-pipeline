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
