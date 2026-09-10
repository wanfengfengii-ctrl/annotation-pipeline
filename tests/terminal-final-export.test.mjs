import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
import { terminalProtocolVersion } from '../scripts/mac-terminal.mjs';
import { verifyTerminalFinalization } from '../scripts/terminal-finalization.mjs';

function fixture(
  t,
  {
    legacy = false,
    failureAt = 0,
    mismatchedCopy = false,
    uncertain = false,
    uncertainRemoval = false,
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'terminal-final-export-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskId = randomUUID(),
    questionId = randomUUID(),
    containerId = 'a'.repeat(64);
  const taskDir = path.join(root, taskId),
    terminalDir = path.join(taskDir, 'questions', questionId, 'terminal');
  const workDir = path.join(taskDir, 'questions', questionId, 'workspace');
  mkdirSync(terminalDir, { recursive: true });
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, 'code.txt'), 'original product');
  const terminal = {
    runId: randomUUID(),
    statePath: path.join(terminalDir, 'state.json'),
    launchPath: path.join(terminalDir, 'question.command'),
    ...(legacy ? {} : { terminalProtocolVersion }),
  };
  const operations = [],
    raw = [];
  let copyCount = 0,
    removed = false,
    removalAcknowledged = false;
  function copy(destination) {
    copyCount++;
    mkdirSync(path.join(destination, '-workspace'), { recursive: true });
    if (failureAt === copyCount) {
      writeFileSync(
        path.join(destination, '-workspace', 'partial.txt'),
        'partial evidence',
      );
      throw Error('synthetic copy failure');
    }
    const content =
      mismatchedCopy && copyCount === 2
        ? 'changed'
        : '{"type":"system","subtype":"turn_duration"}\n';
    writeFileSync(
      path.join(destination, '-workspace', 'session.jsonl'),
      content,
    );
  }
  const rt = new DockerRuntime(
    root,
    async () => {},
    () => false,
    (args) => {
      raw.push(args);
      if (args[0] === 'cp') {
        copy(args[2]);
        return '';
      }
      if (args[0] === 'rm') {
        removed = true;
        removalAcknowledged = true;
        return '';
      }
      throw Error('unexpected Docker command in fixture');
    },
    {
      async command(descriptor, operation) {
        assert.equal(descriptor.runId, terminal.runId);
        operations.push(operation);
        if (operation.action === 'cp') {
          if (uncertain) return { ok: false, status: 'uncertain' };
          try {
            copy(operation.destination);
          } catch {
            return { ok: false, status: 'failed' };
          }
        } else if (operation.action === 'rm') {
          const alreadyRemoved = removed;
          removed = true;
          if (uncertainRemoval && !alreadyRemoved)
            return { ok: false, status: 'uncertain' };
          removalAcknowledged = true;
        } else throw Error('unexpected Terminal command in fixture');
        return {
          ok: true,
          status: 'succeeded',
          operationId: operation.operationId,
        };
      },
      async complete(descriptor, operation) {
        assert.equal(descriptor.runId, terminal.runId);
        assert.ok(removed, 'completion cannot precede actual removal');
        assert.ok(
          removalAcknowledged,
          'completion requires an acknowledged removal operation',
        );
        assert.equal(rt.load(taskId).status, 'removed');
        assert.ok(
          verifyTerminalFinalization({ taskDir, questionId, terminal }),
          'completion requires a verified final receipt',
        );
        operations.push({ ...operation, action: 'complete' });
        return { ok: true };
      },
    },
  );
  rt.owned = () => {
    if (removed)
      throw Object.assign(Error('not found'), { stderr: 'No such container' });
    return { Id: containerId, State: { Running: false } };
  };
  rt.save({
    taskId,
    questionId,
    containerId,
    terminal,
    workDir,
    status: 'stopped',
    results: { fixture: {} },
  });
  return {
    rt,
    taskId,
    questionId,
    taskDir,
    terminal,
    operations,
    raw,
    workDir,
  };
}

test('two verified final copies precede removal and the original Terminal completion signal', async (t) => {
  const f = fixture(t);
  await f.rt.close(f.taskId);
  assert.deepEqual(
    f.operations.map((o) => o.action),
    ['cp', 'cp', 'rm', 'complete'],
  );
  assert.equal(f.raw.length, 0);
  const state = f.rt.load(f.taskId);
  assert.equal(state.status, 'removed');
  assert.equal(state.traceExport.exportKind, 'final');
  assert.equal(state.traceExport.commandTransport, 'original-mac-terminal');
  assert.equal(
    readFileSync(path.join(f.workDir, 'code.txt'), 'utf8'),
    'original product',
  );
  assert.ok(
    verifyTerminalFinalization({
      taskDir: f.taskDir,
      questionId: f.questionId,
      terminal: f.terminal,
    }),
  );
});

test('either copy failure or mismatched stopped-container copies prevents removal and completion', async (t) => {
  for (const options of [
    { failureAt: 1 },
    { failureAt: 2 },
    { mismatchedCopy: true },
  ]) {
    await t.test(JSON.stringify(options), async (child) => {
      const f = fixture(child, options);
      await assert.rejects(
        f.rt.close(f.taskId),
        options.mismatchedCopy
          ? /两次完整轨迹导出校验不一致/
          : /原终端导出未完成/,
      );
      assert.equal(
        f.operations.filter((o) => o.action === 'cp').length,
        options.failureAt || 2,
      );
      assert.ok(
        !f.operations.some((o) => o.action === 'rm' || o.action === 'complete'),
      );
      assert.equal(f.rt.load(f.taskId).status, 'stopped');
    });
  }
});

test('a known partial copy failure is retained and a later close uses fresh destinations', async (t) => {
  const f = fixture(t, { failureAt: 2 });
  await assert.rejects(f.rt.close(f.taskId), /原终端导出未完成/);
  const failedState = f.rt.load(f.taskId),
    oldDir = failedState.finalExportDir;
  const oldCopy = f.operations[1];
  assert.equal(
    readFileSync(
      path.join(oldDir, 'verification', '-workspace', 'partial.txt'),
      'utf8',
    ),
    'partial evidence',
  );
  await f.rt.close(f.taskId);
  const state = f.rt.load(f.taskId);
  assert.notEqual(state.finalExportDir, oldDir);
  assert.equal(state.abandonedFinalExports[0].path, oldDir);
  assert.equal(state.abandonedFinalExports[0].reason, 'copy-failed');
  assert.ok(
    existsSync(path.join(oldDir, 'verification', '-workspace', 'partial.txt')),
  );
  assert.notEqual(f.operations[3].operationId, oldCopy.operationId);
  assert.deepEqual(
    f.operations.map((o) => o.action),
    ['cp', 'cp', 'cp', 'cp', 'rm', 'complete'],
  );
  assert.equal(state.status, 'removed');
});

test('uncertain whole-export retries preserve the copy destination and operation identity', async (t) => {
  const f = fixture(t, { uncertain: true });
  await assert.rejects(f.rt.close(f.taskId), /未完成/);
  await assert.rejects(f.rt.close(f.taskId), /未完成/);
  assert.equal(f.operations.length, 2);
  assert.equal(f.operations[0].destination, f.operations[1].destination);
  assert.equal(f.operations[0].operationId, f.operations[1].operationId);
  assert.ok(
    !f.operations.some((o) => o.action === 'rm' || o.action === 'complete'),
  );
});

test('a lost command response is retried with the same persisted operation ID', async (t) => {
  const f = fixture(t),
    operations = [];
  f.rt.terminalOperations.command = async (_terminal, operation) => {
    operations.push(operation);
    if (operations.length === 1) throw Error('synthetic lost response');
    return { ok: true, status: 'succeeded' };
  };
  await assert.rejects(
    f.rt.finalCommand(f.rt.load(f.taskId), 'rm'),
    /lost response/,
  );
  await f.rt.finalCommand(f.rt.load(f.taskId), 'rm');
  assert.equal(operations[0].operationId, operations[1].operationId);
});

test('an uncertain removal is reconciled through its original operation before completion', async (t) => {
  const f = fixture(t, { uncertainRemoval: true });
  await assert.rejects(f.rt.close(f.taskId), /原终端清理未完成/);
  assert.equal(f.rt.load(f.taskId).status, 'exported');
  await f.rt.close(f.taskId);
  const removals = f.operations.filter((o) => o.action === 'rm');
  assert.equal(removals.length, 2);
  assert.equal(removals[0].operationId, removals[1].operationId);
  assert.deepEqual(
    f.operations.map((o) => o.action),
    ['cp', 'cp', 'rm', 'rm', 'complete'],
  );
  assert.equal(f.rt.load(f.taskId).status, 'removed');
});

test('an unacknowledged completion retries the verified receipt without exporting or removing again', async (t) => {
  const f = fixture(t),
    complete = f.rt.terminalOperations.complete;
  let calls = 0;
  f.rt.terminalOperations.complete = async (...args) => {
    const receipt = await complete(...args);
    return ++calls === 1 ? { ok: false, status: 'uncertain' } : receipt;
  };
  await assert.rejects(f.rt.close(f.taskId), /尚未确认最终完成/);
  assert.equal(f.rt.load(f.taskId).status, 'removed');
  assert.equal(f.rt.load(f.taskId).terminalFinalization, undefined);
  await f.rt.close(f.taskId);
  assert.deepEqual(
    f.operations.map((o) => o.action),
    ['cp', 'cp', 'rm', 'complete', 'complete'],
  );
  assert.equal(f.operations[3].operationId, f.operations[4].operationId);
  assert.equal(
    f.rt.load(f.taskId).terminalFinalization.runId,
    f.terminal.runId,
  );
});

test('legacy migration still verifies both copies and identifies its transport honestly', async (t) => {
  const f = fixture(t, { legacy: true });
  await f.rt.close(f.taskId);
  assert.deepEqual(
    f.raw.map((args) => args[0]),
    ['cp', 'cp', 'rm'],
  );
  assert.equal(f.operations.length, 0);
  const receipt = verifyTerminalFinalization({
    taskDir: f.taskDir,
    questionId: f.questionId,
    terminal: f.terminal,
  });
  assert.equal(receipt.commandTransport, 'legacy-runner-migration');
  assert.equal(f.rt.load(f.taskId).status, 'removed');
});

test('legacy second-copy failure keeps the old container and never signals completion', async (t) => {
  const f = fixture(t, { legacy: true, failureAt: 2 });
  await assert.rejects(f.rt.close(f.taskId), /copy failure/);
  assert.deepEqual(
    f.raw.map((args) => args[0]),
    ['cp', 'cp'],
  );
  assert.equal(f.operations.length, 0);
});

test('a removed state cannot signal completion using an intermediate or fabricated export', async (t) => {
  const f = fixture(t),
    state = f.rt.load(f.taskId);
  state.status = 'removed';
  state.traceExport = {
    verified: true,
    exportKind: 'intermediate',
    path: path.join(f.taskDir, 'round.traces-1', 'projects'),
  };
  f.rt.save(state);
  await assert.rejects(f.rt.finalizeTerminal(state), /最终导出/);
  assert.equal(f.operations.length, 0);
});
