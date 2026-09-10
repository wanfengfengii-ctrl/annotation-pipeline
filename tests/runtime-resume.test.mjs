import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  verifyRuntime,
  reuseRuntimeDiagnosis,
  reuseRuntimeVerification,
} from '../scripts/runtime-verification.mjs';
import { runtimeBrowserCache } from '../scripts/runtime-browser-cache.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const capabilities = {
  commands: Object.fromEntries(
    [
      'bash',
      'node',
      'npm',
      'python3',
      'pip',
      'pip3',
      'apt-get',
      'apk',
      'dnf',
      'yum',
      'chromium',
      'chromium-browser',
      'google-chrome',
      'firefox',
    ].map((name) => [name, ['bash', 'node', 'npm'].includes(name)]),
  ),
  pythonModules: null,
};

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-resume-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'source');
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, 'app.js'), 'console.log("result");\n');
  const context = {
    taskId: path.basename(dir),
    turnId: 'turn',
    dir,
    workDir,
    imageId: 'sha256:' + 'a'.repeat(64),
    prompt: 'Display the result',
    acceptance: ['result is displayed'],
  };
  const planValue = {
    summary: 'Start the project and inspect its actual result',
    checks: [
      { id: 'setup', kind: 'setup', command: 'node -v', codeEvidence: '无' },
      {
        id: 'acceptance',
        kind: 'acceptance',
        command: 'node app.js',
        codeEvidence: 'app.js:1',
      },
    ].map((check) => ({
      ...check,
      timeoutSeconds: 10,
      expected: 'result',
      requirement: 'display result',
    })),
  };
  const calls = [],
    stages = [],
    checkpoints = [];
  let generation = 0;
  const f = {
    context,
    calls,
    stages,
    checkpoints,
    planValue,
    executionFailure: null,
    failureCommand: 'node app.js',
    diagnosisMode: 'bad-line',
    step: async (stage) => {
      stages.push(stage);
      if (stage === 'runtime-running') return;
      const tracePath = path.join(dir, `trace-${++generation}.${stage}.jsonl`);
      writeFileSync(tracePath, '{}\n');
      if (stage === 'runtime-plan') return { tracePath, value: planValue };
      assert.equal(stage, 'runtime-diagnose');
      if (f.diagnosisMode === 'transport')
        throw Error('diagnosis transport failed');
      return {
        tracePath,
        value: {
          summary:
            f.diagnosisMode === 'blocked'
              ? 'Test locator was incorrect'
              : 'Observed the result',
          checks: planValue.checks.map((check) => ({
            id: check.id,
            outcome:
              f.diagnosisMode === 'blocked' && check.kind !== 'setup'
                ? 'blocked'
                : 'passed',
            observed: 'Recorded the actual output',
            evidenceLine: f.diagnosisMode === 'bad-line' ? 50 : 1,
          })),
        },
      };
    },
    docker: async (args, options = {}) => {
      calls.push(args);
      const output = args.includes('annotation.verification-probe=true')
        ? JSON.stringify(capabilities)
        : args[0] === 'exec'
          ? 'result\rprogress\nASSERT PASS\n'
          : 'container';
      if (options.logPath) writeFileSync(options.logPath, output);
      return {
        exitCode: 0,
        timedOut: false,
        limited: false,
        output,
        logPath: options.logPath,
        logSha256: hash(output),
        ...(args[0] === 'exec' && args.at(-1) === f.failureCommand
          ? f.executionFailure
          : {}),
      };
    },
    run: (extra = {}) =>
      verifyRuntime({
        ...context,
        logicalTurnId: context.turnId,
        turnId: 'turn.attempt-1',
        browserCache: null,
        onDiagnosisCheckpoint: (receipt) => checkpoints.push(receipt),
        docker: f.docker,
        step: f.step,
        ...extra,
      }),
  };
  return f;
}

test('a failed diagnosis resumes only diagnosis with unchanged execution and no browser preparation', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(), /日志摘要或行号无效/);
  const receipt = f.checkpoints.at(-1);
  const checkpoint = reuseRuntimeDiagnosis(receipt, f.context);
  assert.ok(checkpoint);
  const root = path.dirname(receipt.checkpointPath);
  const retained = [
    receipt.checkpointPath,
    checkpoint.executionPath,
    checkpoint.sourceManifestPath,
    checkpoint.environmentProbe.logPath,
    checkpoint.plan.tracePath,
    ...checkpoint.runs.map((run) => run.logPath),
    ...readdirSync(root)
      .filter((name) => name.startsWith('diagnosis-evidence-'))
      .flatMap((name) =>
        readdirSync(path.join(root, name)).map((file) =>
          path.join(root, name, file),
        ),
      ),
  ].map((file) => [file, readFileSync(file)]);
  const dockerCalls = f.calls.length;
  f.stages.length = 0;
  f.diagnosisMode = 'passed';
  t.mock.method(runtimeBrowserCache, 'ensure', () => {
    assert.fail(
      'Diagnosis recovery must not prepare or redownload the browser',
    );
  });
  const report = await f.run({
    turnId: 'turn.attempt-2',
    diagnosisCheckpoint: receipt,
    browserCache: undefined,
  });
  assert.equal(report.status, 'passed');
  assert.equal(
    f.calls.length,
    dockerCalls,
    'no probe or verification container is started again',
  );
  assert.deepEqual(f.stages, ['runtime-diagnose']);
  assert.equal(report.executionPath, checkpoint.executionPath);
  assert.equal(reuseRuntimeVerification(report, f.context), report);
  assert.equal(
    reuseRuntimeDiagnosis(receipt, f.context),
    null,
    'a completed report ends diagnosis recovery',
  );
  assert.equal(f.checkpoints.filter(Boolean).length, 1);
  for (const [file, bytes] of retained)
    assert.deepEqual(readFileSync(file), bytes);
});

test('diagnosis transport failure retains the same verified execution for the next attempt', async (t) => {
  const f = fixture(t);
  f.diagnosisMode = 'transport';
  await assert.rejects(f.run(), /transport failed/);
  assert.ok(reuseRuntimeDiagnosis(f.checkpoints.at(-1), f.context));
  f.diagnosisMode = 'passed';
  const report = await f.run({
    diagnosisCheckpoint: f.checkpoints.at(-1),
    turnId: 'turn.attempt-2',
  });
  assert.equal(report.status, 'passed');
  assert.equal(f.stages.filter((stage) => stage === 'runtime-plan').length, 1);
});

test('changed inputs, source, execution, trace or archived environment invalidate diagnosis recovery', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run(), /日志摘要或行号无效/);
  const receipt = f.checkpoints.at(-1);
  const checkpoint = reuseRuntimeDiagnosis(receipt, f.context);
  for (const patch of [
    { taskId: 'other' },
    { turnId: 'other' },
    { imageId: 'sha256:' + 'b'.repeat(64) },
    { prompt: 'A different question' },
    { acceptance: ['different behavior'] },
    { regressionContext: { checks: [] } },
  ])
    assert.equal(
      reuseRuntimeDiagnosis(receipt, { ...f.context, ...patch }),
      null,
    );
  assert.equal(
    reuseRuntimeDiagnosis(
      { ...receipt, checkpointSha256: '0'.repeat(64) },
      f.context,
    ),
    null,
  );
  for (const file of [
    receipt.checkpointPath,
    checkpoint.executionPath,
    checkpoint.sourceManifestPath,
    checkpoint.environmentProbe.logPath,
    checkpoint.plan.tracePath,
    ...checkpoint.runs.map((run) => run.logPath),
    path.join(f.context.workDir, 'app.js'),
  ]) {
    const original = readFileSync(file);
    writeFileSync(file, 'altered evidence');
    assert.equal(reuseRuntimeDiagnosis(receipt, f.context), null, file);
    writeFileSync(file, original);
  }
  assert.ok(reuseRuntimeDiagnosis(receipt, f.context));
  writeFileSync(
    path.join(f.context.workDir, 'app.js'),
    'console.log("changed");\n',
  );
  f.diagnosisMode = 'passed';
  f.stages.length = 0;
  const report = await f.run({
    diagnosisCheckpoint: receipt,
    turnId: 'turn.attempt-2',
  });
  assert.equal(report.status, 'passed');
  assert.equal(
    f.checkpoints[1],
    null,
    'the invalid persisted receipt is cleared',
  );
  assert.equal(f.stages[0], 'runtime-plan');
  assert.notEqual(report.executionPath, checkpoint.executionPath);
});

test('a valid blocked diagnosis forces fresh planning and execution even with the old checkpoint', async (t) => {
  const f = fixture(t);
  f.diagnosisMode = 'blocked';
  const blocked = await f.run();
  const receipt = f.checkpoints.at(-1);
  assert.equal(blocked.status, 'blocked');
  assert.equal(reuseRuntimeDiagnosis(receipt, f.context), null);
  f.diagnosisMode = 'passed';
  f.stages.length = 0;
  const report = await f.run({
    diagnosisCheckpoint: receipt,
    turnId: 'turn.attempt-2',
  });
  assert.equal(f.stages[0], 'runtime-plan');
  assert.notEqual(report.executionPath, blocked.executionPath);
  assert.equal(
    JSON.parse(readFileSync(blocked.reportPath, 'utf8')).status,
    'blocked',
  );
});

test('environment failures, incomplete executions and changed source never publish a diagnosis resume receipt', async (t) => {
  for (const failure of [
    { exitCode: 2 },
    { exitCode: null },
    { timedOut: true },
    { limited: true },
  ]) {
    const f = fixture(t);
    f.executionFailure = failure;
    await assert.rejects(f.run(), /日志摘要或行号无效/);
    assert.deepEqual(f.checkpoints, [], JSON.stringify(failure));
  }
  const incomplete = fixture(t);
  incomplete.failureCommand = 'node -v';
  incomplete.executionFailure = { exitCode: 2 };
  incomplete.diagnosisMode = 'transport';
  await assert.rejects(incomplete.run(), /transport failed/);
  assert.deepEqual(incomplete.checkpoints, []);
  assert.equal(incomplete.calls.filter((args) => args[0] === 'exec').length, 1);
  const f = fixture(t);
  const docker = f.docker;
  f.docker = async (args, options) => {
    if (args[0] === 'exec' && args.at(-1) === 'node app.js') {
      const run = f.calls.find((call) =>
        call.includes('annotation.verification=true'),
      );
      const mount = run[run.indexOf('--mount') + 1];
      const workspace = mount.match(
        /^type=bind,source=(.*),target=\/workspace$/,
      )[1];
      writeFileSync(
        path.join(workspace, 'app.js'),
        'console.log("modified");\n',
      );
    }
    return docker(args, options);
  };
  await assert.rejects(f.run(), /日志摘要或行号无效/);
  assert.deepEqual(f.checkpoints, []);
});
