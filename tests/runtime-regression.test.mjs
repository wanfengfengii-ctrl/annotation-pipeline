import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  verifyRuntime,
  reuseRuntimeVerification,
  runtimeInputDigest,
} from '../scripts/runtime-verification.mjs';
import { projectRegressionVersion } from '../scripts/project-regression-context.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const imageId = 'sha256:' + 'a'.repeat(64);
const prompt = '修好当前操作，保留原来的使用流程。';
const acceptance = ['当前操作返回 1'];
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
    ].map((name) => [name, ['bash', 'node', 'npm', 'python3'].includes(name)]),
  ),
  pythonModules: {
    venv: true,
    ensurepip: false,
    pip: false,
    playwright: false,
  },
};
const currentCheck = {
  id: 'current_acceptance',
  kind: 'acceptance',
  command: 'check-current-operation',
  expected: 'current=1',
  requirement: acceptance[0],
  codeEvidence: 'app.js:1',
  timeoutSeconds: 10,
};
const oldCheck = {
  id: 'old_bug',
  kind: 'reproduction',
  command: 'check-old-operation',
  expected: 'legacy=1',
  requirement: '先前操作返回 1',
  codeEvidence: 'app.js:2',
  timeoutSeconds: 10,
};

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'runtime-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'source');
  mkdirSync(workDir);
  writeFileSync(
    path.join(workDir, 'app.js'),
    'export const current = 1;\nexport const legacy = 0;\n',
  );
  return { dir, workDir, taskId: path.basename(dir) };
}

async function execute(
  f,
  {
    regressionContext = null,
    checks = [currentCheck, oldCheck],
    turnId = 'current',
    calls = [],
  } = {},
) {
  const report = await verifyRuntime({
    dir: f.dir,
    workDir: f.workDir,
    turnId: turnId + '.attempt-1',
    imageId,
    prompt,
    acceptance,
    regressionContext,
    browserCache: null,
    docker: async (args, options = {}) => {
      calls.push(args);
      let output = 'container removed or started\n',
        exitCode = 0;
      if (args.includes('annotation.verification-probe=true'))
        output = JSON.stringify(capabilities);
      if (args[0] === 'exec') {
        assert.equal(args.at(-2), '-c');
        const command = args.at(-1);
        assert([currentCheck.command, oldCheck.command].includes(command));
        output =
          command === currentCheck.command
            ? 'expected current=1; actual current=1; ASSERT PASS\n'
            : 'expected legacy=1; actual legacy=0; ASSERT FAIL\n';
        exitCode = command === oldCheck.command ? 1 : 0;
      }
      if (options.logPath) writeFileSync(options.logPath, output);
      return {
        output,
        exitCode,
        timedOut: false,
        limited: false,
        logPath: options.logPath,
        logSha256: hash(output),
      };
    },
    step: async (stage, instruction, cwd) => {
      assert.equal(cwd, f.workDir);
      if (stage === 'runtime-running') return;
      assert(['runtime-plan', 'runtime-diagnose'].includes(stage));
      if (regressionContext)
        assert(instruction.includes(JSON.stringify(regressionContext)));
      const tracePath = path.join(
        f.dir,
        `${turnId}.${stage}-${randomUUID()}.jsonl`,
      );
      writeFileSync(tracePath, '{"type":"result","fixture":true}\n');
      return {
        tracePath,
        value:
          stage === 'runtime-plan'
            ? { summary: '执行当前行为并重新检查先前缺陷', checks }
            : {
                summary: '当前行为通过，先前缺陷在新产物上仍复现',
                checks: checks.map((check) => ({
                  id: check.id,
                  outcome: check.id === oldCheck.id ? 'reproduced' : 'passed',
                  observed:
                    check.id === oldCheck.id ? 'legacy=0，预期 1' : 'current=1',
                  evidenceLine: 1,
                })),
              },
      };
    },
  });
  return {
    report,
    calls,
    context: {
      dir: f.dir,
      workDir: f.workDir,
      taskId: f.taskId,
      turnId,
      imageId,
      prompt,
      acceptance,
      regressionContext,
    },
  };
}

async function history(f) {
  const { report } = await execute(f, { turnId: 'original' });
  const old = report.checks.find((check) => check.id === oldCheck.id);
  return {
    version: projectRegressionVersion,
    taskId: f.taskId,
    questionRootId: 'original',
    checks: [
      {
        id: old.id,
        scope: 'inherited-regression',
        requirement: old.requirement,
        expected: old.expected,
        observed: old.observed,
        sourceTurnId: 'original',
        sourceReportPath: report.reportPath,
        sourceReportSha256: report.reportSha256,
        sourceLogPath: old.logPath,
        sourceLogSha256: old.logSha256,
        sourcePrompt: prompt,
        sourceAcceptance: acceptance,
      },
    ],
  };
}

test('runtime executes current acceptance and inherited bug with fresh evidence and reusable bound context', async (t) => {
  const f = fixture(t),
    regressionContext = await history(f);
  const before = readFileSync(regressionContext.checks[0].sourceReportPath);
  const { report, context, calls } = await execute(f, { regressionContext });
  assert.equal(report.status, 'bugs');
  assert.deepEqual(report.regressionContext, regressionContext);
  assert.equal(report.inputDigest, runtimeInputDigest(context));
  assert.notEqual(
    report.inputDigest,
    runtimeInputDigest({ imageId, prompt, acceptance }),
  );
  assert.deepEqual(
    report.checks.map((c) => [c.id, c.outcome, c.exitCode]),
    [
      ['current_acceptance', 'passed', 0],
      ['old_bug', 'reproduced', 1],
    ],
  );
  assert.deepEqual(
    calls.filter((args) => args[0] === 'exec').map((args) => args.at(-1)),
    [currentCheck.command, oldCheck.command],
  );
  for (const check of report.checks) {
    assert.equal(hash(readFileSync(check.logPath)), check.logSha256);
    assert(
      check.logPath.startsWith(path.dirname(report.reportPath) + path.sep),
    );
  }
  const currentOld = report.checks.find((c) => c.id === 'old_bug');
  assert.notEqual(
    currentOld.logPath,
    regressionContext.checks[0].sourceLogPath,
  );
  for (const view of report.diagnosisEvidence.logs)
    assert.equal(hash(readFileSync(view.numberedPath)), view.numberedSha256);
  const saved = JSON.parse(readFileSync(report.reportPath));
  assert.deepEqual(saved.regressionContext, regressionContext);
  assert.equal(hash(readFileSync(report.reportPath)), report.reportSha256);
  assert.strictEqual(reuseRuntimeVerification(report, context), report);
  assert.deepEqual(
    readFileSync(regressionContext.checks[0].sourceReportPath),
    before,
  );
});

test('runtime reuse rejects changed or removed regression scope without altering the recorded report', async (t) => {
  const f = fixture(t),
    regressionContext = await history(f);
  const { report, context } = await execute(f, { regressionContext });
  const before = readFileSync(report.reportPath);
  const changed = structuredClone(regressionContext);
  changed.checks[0].expected = 'legacy=2';
  assert.equal(
    reuseRuntimeVerification(report, {
      ...context,
      regressionContext: changed,
    }),
    null,
  );
  assert.equal(
    reuseRuntimeVerification(report, { ...context, regressionContext: null }),
    null,
  );
  assert.deepEqual(readFileSync(report.reportPath), before);
});

for (const source of ['sourceLogPath', 'sourceReportPath']) {
  test(
    'changed historical ' + source + ' prevents both execution and reuse',
    async (t) => {
      const f = fixture(t),
        regressionContext = await history(f);
      const { report, context } = await execute(f, { regressionContext });
      const before = readFileSync(report.reportPath),
        calls = [];
      writeFileSync(
        regressionContext.checks[0][source],
        'tampered historical evidence\n',
      );
      assert.equal(reuseRuntimeVerification(report, context), null);
      await assert.rejects(
        execute(f, { regressionContext, calls }),
        /历史回归证据文件或摘要无效/,
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(readFileSync(report.reportPath), before);
    },
  );
}

for (const [label, checks, error] of [
  ['omitted inherited ID', [currentCheck], /遗漏历史待复核检查/],
  [
    'historical checks standing in for current acceptance',
    [{ ...oldCheck, kind: 'acceptance' }],
    /不能用历史回归代替本题/,
  ],
]) {
  test(
    'runtime rejects ' + label + ' before starting business checks',
    async (t) => {
      const f = fixture(t),
        regressionContext = await history(f),
        calls = [];
      const previous = readFileSync(
        regressionContext.checks[0].sourceReportPath,
      );
      await assert.rejects(
        execute(f, { regressionContext, checks, calls }),
        error,
      );
      assert.equal(calls.filter((args) => args[0] === 'exec').length, 0);
      assert(
        !calls.some((args) => args.includes('annotation.verification=true')),
      );
      assert.deepEqual(
        readFileSync(regressionContext.checks[0].sourceReportPath),
        previous,
      );
    },
  );
}

test('reports without regression context keep the original input digest and reuse behavior', async (t) => {
  const f = fixture(t),
    { report, context } = await execute(f, { checks: [currentCheck] });
  const legacyDigest = hash(JSON.stringify({ imageId, prompt, acceptance }));
  assert.equal(report.inputDigest, legacyDigest);
  assert.equal(
    runtimeInputDigest({ imageId, prompt, acceptance }),
    legacyDigest,
  );
  assert.equal(
    runtimeInputDigest({
      imageId,
      prompt,
      acceptance,
      regressionContext: null,
    }),
    legacyDigest,
  );
  assert.equal(Object.hasOwn(report, 'regressionContext'), false);
  assert.equal(report.status, 'passed');
  assert.strictEqual(reuseRuntimeVerification(report, context), report);
});
