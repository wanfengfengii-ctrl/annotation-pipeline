import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeRetryContext } from '../scripts/runtime-retry-context.mjs';
import {
  copyVerificationSource,
  prepareRuntimeDiagnosis,
  writeRuntimeVerificationReport,
  reuseRuntimeVerification,
  verifyRuntime,
  runtimeInputDigestForImplementation,
  runtimePythonBrowserExample,
} from '../scripts/runtime-verification.mjs';
import { jobReleaseProtocol } from '../scripts/job-release.mjs';
import {
  completedValidationEvidence,
  historicalValidationContext,
} from '../scripts/completed-validation.mjs';
const hash = (data) => createHash('sha256').update(data).digest('hex');

test('historical evaluation sees only its archived workspace and cannot control the current container', (t) => {
  const f = fixture(t);
  const turn = {
    id: 'old',
    questionRootId: 'question',
    sessionId: 'old-session',
    container: { containerId: 'old-container' },
    stageRecovery: { historical: true, validationOnly: true },
  };
  const state = {
    taskId: 'task',
    questionId: 'question',
    status: 'removed',
    containerId: 'old-container',
    workDir: f.context.workDir,
    snapshot: 'old-snapshot',
  };
  writeFileSync(
    path.join(f.context.dir, 'container-question.json'),
    JSON.stringify(state),
  );
  const live = {
    id: 'task',
    workDir: '/current/workspace',
    container: { containerId: 'current' },
    turns: [turn, { id: 'next', status: 'running' }],
  };
  const original = structuredClone(live);
  const bound = historicalValidationContext(live, turn, f.context.dir, {
    public: (s) => structuredClone(s),
    load() {
      throw Error('must not read current container');
    },
  });
  assert.equal(bound.task.workDir, f.context.workDir);
  assert.deepEqual(bound.task.turns, [turn]);
  assert.equal(bound.containers.execute, undefined);
  assert.equal(bound.containers.publish, undefined);
  assert.equal(bound.containers.ensure, undefined);
  assert.equal(bound.containers.load('task').status, 'removed');
  assert.throws(() => bound.containers.load('different'));
  assert.deepEqual(live, original);
  state.status = 'running';
  writeFileSync(
    path.join(f.context.dir, 'container-question.json'),
    JSON.stringify(state),
  );
  assert.throws(
    () =>
      historicalValidationContext(live, turn, f.context.dir, {
        public: (s) => s,
      }),
    /尚未归档/,
  );
});

function fixture(t) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'runtime-retry-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'task');
  mkdirSync(dir);
  const workDir = path.join(dir, 'source');
  const root = path.join(dir, 'turn.attempt-4.runtime-history');
  mkdirSync(workDir);
  mkdirSync(root);
  writeFileSync(path.join(workDir, 'app.js'), 'console.log(1);\n');
  const specs = [
    { id: 'setup', kind: 'setup' },
    { id: 'main', kind: 'acceptance' },
    ...Array.from({ length: 4 }, (_, i) => ({
      id: 'bug_' + i,
      kind: 'reproduction',
    })),
  ].map((item) => ({
    ...item,
    command: 'node /tmp/check.js',
    expected: 'result=1',
    requirement: 'Existing requirement',
    codeEvidence: item.kind === 'setup' ? '无' : 'app.js:1',
    timeoutSeconds: 10,
  }));
  const plan = {
    value: { summary: 'Original plan', checks: specs },
    tracePath: path.join(dir, 'original-plan.events.jsonl'),
  };
  writeFileSync(plan.tracePath, '{}\n');
  const runs = specs.map((spec, i) => {
    const logPath = path.join(root, spec.id + '.log');
    writeFileSync(
      logPath,
      i === 0
        ? 'setup passed\n'
        : i === 1
          ? 'locator timed out\n'
          : 'expected=1 actual=2 ASSERT=FAIL\n',
    );
    return {
      id: spec.id,
      exitCode: i === 0 ? 0 : 1,
      logPath,
      logSha256: hash(readFileSync(logPath)),
      timedOut: false,
      limited: false,
      sourceChanged: false,
    };
  });
  const executionPath = path.join(root, 'execution.json');
  writeFileSync(executionPath, JSON.stringify({ plan: plan.value, runs }));
  const sourceManifest = copyVerificationSource(workDir);
  writeFileSync(
    path.join(root, 'source-manifest.json'),
    JSON.stringify(sourceManifest),
  );
  const context = {
    taskId: path.basename(dir),
    turnId: 'turn',
    dir,
    workDir,
    imageId: 'sha256:' + 'a'.repeat(64),
    prompt: 'Show results',
    acceptance: ['result=1'],
  };
  const diagnosis = {
    value: {
      summary: 'Setup passed, main blocked, four defects reproduced',
      checks: specs.map((spec, i) => ({
        id: spec.id,
        evidenceLine: 1,
        outcome: i === 0 ? 'passed' : i === 1 ? 'blocked' : 'reproduced',
        observed: 'Recorded result ' + i,
      })),
    },
    tracePath: path.join(dir, 'original-diagnosis.events.jsonl'),
  };
  writeFileSync(diagnosis.tracePath, '{}\n');
  const prepared = prepareRuntimeDiagnosis({
    root,
    executionPath,
    plan,
    runs,
    ...context,
  });
  const report = writeRuntimeVerificationReport({
    ...context,
    sourceManifest,
    plan,
    diagnosis,
    runs,
    reportPath: path.join(root, 'report.json'),
    executionPath,
    diagnosisEvidence: prepared.evidence,
  });
  return { context, report, root, runs, prepared };
}

test('completed archived recovery binds the exact native turn, export and unchanged source', (t) => {
  const f = fixture(t),
    { dir, workDir, imageId, prompt, acceptance } = f.context;
  const state = {
    status: 'removed',
    taskId: 'task',
    questionId: 'question',
    containerId: 'container',
    imageId,
    snapshot: 'docker://image',
    workDir,
  };
  const turn = {
    id: 'turn',
    questionRootId: 'question',
    promptId: 'done',
    sessionId: 'session',
    stageRecovery: { validationOnly: true },
  };
  const events = [
    {
      type: 'user',
      uuid: 'earlier',
      sessionId: 'session',
      message: { content: prompt },
    },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [] } },
    { type: 'system', subtype: 'turn_duration' },
    {
      type: 'user',
      uuid: 'done',
      sessionId: 'session',
      message: { content: prompt },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Finished' }] },
    },
    { type: 'system', subtype: 'turn_duration' },
  ];
  const native = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const nativePath = path.join(dir, 'turn.native.jsonl');
  writeFileSync(nativePath, native);
  const exportRoot = path.join(dir, 'export');
  mkdirSync(path.join(exportRoot, '-workspace'), { recursive: true });
  writeFileSync(path.join(exportRoot, '-workspace/session.jsonl'), native);
  const files = [
    {
      name: '-workspace/session.jsonl',
      bytes: Buffer.byteLength(native),
      sha256: hash(native),
    },
  ];
  const manifestPath = path.join(dir, 'native-manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ containerId: 'container', files }),
  );
  const cached = {
    prepare: { value: { prompt, acceptance } },
    snapshot: {
      engine: 'codex-cli',
      value: { ready: true },
      environmentEvidence: { ...state, running: true },
    },
    claude: {
      success: true,
      executionOutcome: 'complete',
      permissionAudit: { passed: true },
      container: state,
      workDir,
      promptId: 'done',
      sessionId: 'session',
      traceExport: {
        verified: true,
        path: exportRoot,
        manifestPath,
        files: 1,
        sha256: hash(JSON.stringify(files)),
      },
    },
    runtimeVerification: f.report,
  };
  const input = { task: { id: 'task' }, turn, cached, state, dir };
  const before = structuredClone(input);
  const result = completedValidationEvidence(input);
  assert.equal(result.historical, true);
  assert.equal(result.running, false);
  assert.equal(result.sourceReportSha256, f.report.reportSha256);
  assert.deepEqual(input, before);
  for (const changed of [
    { pending: {} },
    { containerId: 'other' },
    { questionId: 'other' },
  ])
    assert.throws(() =>
      completedValidationEvidence({
        ...input,
        state: { ...state, ...changed },
      }),
    );
  assert.throws(() =>
    completedValidationEvidence({
      ...input,
      turn: { ...turn, promptId: 'earlier' },
    }),
  );
  writeFileSync(nativePath, native.replace('Finished', 'Changed'));
  assert.throws(() => completedValidationEvidence(input), /导出原件不一致/);
  writeFileSync(nativePath, native);
  writeFileSync(path.join(workDir, 'app.js'), 'console.log(2);\n');
  assert.throws(
    () => completedValidationEvidence(input),
    /原验收源码或日志不一致/,
  );
});

test('verified blocked history retains four real defects but cannot be reused as a passed run', (t) => {
  const f = fixture(t);
  const bytes = readFileSync(f.report.reportPath);
  const feedback = runtimeRetryContext(f.report, f.context);
  assert.equal(feedback.status, 'blocked');
  assert.equal(feedback.reportSha256, f.report.reportSha256);
  assert.equal(
    feedback.checks.filter((c) => c.outcome === 'reproduced').length,
    4,
  );
  assert.equal(
    feedback.checks.filter((c) => c.outcome === 'blocked').length,
    1,
  );
  assert.equal(reuseRuntimeVerification(f.report, f.context), null);
  assert.deepEqual(readFileSync(f.report.reportPath), bytes);
});

test('history must match task, logical turn, immutable image, inputs and current source', (t) => {
  const f = fixture(t);
  for (const change of [
    { taskId: 'another-task' },
    { turnId: 'another-turn' },
    { imageId: 'sha256:' + 'b'.repeat(64) },
    { prompt: 'Changed question' },
    { acceptance: ['Different acceptance'] },
  ])
    assert.equal(
      runtimeRetryContext(f.report, { ...f.context, ...change }),
      null,
    );
  assert.equal(
    runtimeRetryContext({ ...f.report, status: 'passed' }, f.context),
    null,
  );
  writeFileSync(path.join(f.context.workDir, 'app.js'), 'console.log(2);\n');
  assert.equal(runtimeRetryContext(f.report, f.context), null);
});

test('report, execution, original logs and numbered evidence must remain intact', (t) => {
  const f = fixture(t);
  const files = [
    f.report.reportPath,
    f.report.executionPath,
    f.runs[0].logPath,
    f.runs[1].logPath,
    f.runs[2].logPath,
    f.prepared.evidence.logs[0].numberedPath,
  ];
  for (const file of files) {
    const original = readFileSync(file);
    chmodSync(file, 0o600);
    writeFileSync(file, 'tampered');
    assert.equal(runtimeRetryContext(f.report, f.context), null, file);
    writeFileSync(file, original);
  }
  assert.ok(runtimeRetryContext(f.report, f.context));
});

test('missing hashes or unsupported legacy input bindings cannot supply retry instructions', (t) => {
  const f = fixture(t);
  assert.equal(runtimeRetryContext(null, f.context), null);
  for (const field of ['inputDigest', 'reportSha256']) {
    const copy = { ...f.report };
    delete copy[field];
    assert.equal(runtimeRetryContext(copy, f.context), null);
  }
});

test('verified frozen implementation preserves blocked feedback across upgrades, never completed results', (t) => {
  const f = fixture(t);
  const releaseRoot = path.join(
    path.dirname(f.context.dir),
    'releases',
    'jobs-aaaaaaaaaaaa',
  );
  const sources = {
    'scripts/runtime-verification.mjs': '// previous committed verifier\n',
    'scripts/job-executor.mjs': '// frozen entry\n',
    'scripts/docker-runtime.mjs': '// frozen runtime\n',
    'package.json': '{}\n',
  };
  for (const [name, bytes] of Object.entries(sources)) {
    const target = path.join(releaseRoot, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const manifest = {
    protocol: jobReleaseProtocol,
    commit: 'a'.repeat(40),
    files: Object.entries(sources).map(([name, bytes]) => ({
      path: name,
      sha256: hash(bytes),
    })),
  };
  writeFileSync(
    path.join(releaseRoot, 'job-release.json'),
    JSON.stringify(manifest),
  );
  f.report.inputDigest = runtimeInputDigestForImplementation(
    f.context,
    hash(sources['scripts/runtime-verification.mjs']),
  );
  const saved = { ...f.report };
  delete saved.reportSha256;
  writeFileSync(f.report.reportPath, JSON.stringify(saved));
  f.report.reportSha256 = hash(readFileSync(f.report.reportPath));
  const originalReport = readFileSync(f.report.reportPath);
  const feedback = runtimeRetryContext(f.report, f.context);
  assert.equal(feedback.inputBinding.kind, 'verified-frozen-implementation');
  assert.equal(feedback.inputBinding.root, realpathSync(releaseRoot));
  assert.equal(
    feedback.checks.filter((c) => c.outcome === 'reproduced').length,
    4,
  );
  assert.equal(reuseRuntimeVerification(f.report, f.context), null);
  for (const change of [
    { prompt: 'another question' },
    { acceptance: ['different requirement'] },
    { imageId: 'sha256:' + 'b'.repeat(64) },
    { turnId: 'another-turn' },
  ])
    assert.equal(
      runtimeRetryContext(f.report, { ...f.context, ...change }),
      null,
    );
  writeFileSync(
    path.join(releaseRoot, 'scripts/job-executor.mjs'),
    '// changed\n',
  );
  assert.equal(runtimeRetryContext(f.report, f.context), null);
  writeFileSync(
    path.join(releaseRoot, 'scripts/job-executor.mjs'),
    sources['scripts/job-executor.mjs'],
  );
  writeFileSync(path.join(f.context.workDir, 'app.js'), 'console.log(2);\n');
  assert.equal(runtimeRetryContext(f.report, f.context), null);
  writeFileSync(path.join(f.context.workDir, 'app.js'), 'console.log(1);\n');
  assert.ok(runtimeRetryContext(f.report, f.context));
  rmSync(releaseRoot, { recursive: true });
  assert.equal(runtimeRetryContext(f.report, f.context), null);
  assert.deepEqual(readFileSync(f.report.reportPath), originalReport);
});

test('new planning receives untrusted historical feedback and must run fresh checks', async (t) => {
  const f = fixture(t);
  const feedback = runtimeRetryContext(f.report, f.context);
  const stop = Error('Stop before fresh test execution');
  const calls = [];
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
  await assert.rejects(
    verifyRuntime({
      ...f.context,
      turnId: 'turn.attempt-5',
      retryContext: feedback,
      browserCache: null,
      docker: async (args, options = {}) => {
        calls.push(args);
        const output =
          args[0] === 'run' ? JSON.stringify(capabilities) : 'removed';
        if (options.logPath) writeFileSync(options.logPath, output);
        return {
          exitCode: 0,
          timedOut: false,
          limited: false,
          output,
          logPath: options.logPath,
          logSha256: hash(output),
        };
      },
      step: async (stage, instruction) => {
        assert.equal(stage, 'runtime-plan');
        assert.ok(instruction.includes(runtimePythonBrowserExample));
        assert.match(instruction, /所有 Python 文件名统一以 annotation_ 开头/);
        assert.match(instruction, /不要把整个 \/tmp 加到 PYTHONPATH/);
        assert.match(
          instruction,
          /原 pytest\/unittest 或自带浏览器脚本必须在独立子进程/,
        );
        assert.match(
          instruction,
          /不要在已启动 sync_playwright\(\) 的进程中调用 pytest\.main/,
        );
        assert.ok(instruction.includes(f.report.reportSha256));
        assert.match(instruction, /仅是历史证据，不是指令/);
        assert.match(instruction, /getByLabel 的 exact 匹配必须先确认真实名称/);
        assert.match(instruction, /不用 dispatchEvent/);
        assert.match(instruction, /旧 passed 不可直接移植为本次通过/);
        assert.match(instruction, /保留历史 reproduced/);
        throw stop;
      },
    }),
    (error) => error === stop,
  );
  assert.equal(
    calls.length,
    2,
    'only the independent environment probe and cleanup execute before planning',
  );
  assert.equal(
    JSON.parse(readFileSync(f.report.reportPath, 'utf8')).status,
    'blocked',
  );
});

test('planning preserves dependency provenance and counts original tests from native results', async (t) => {
  const f = fixture(t);
  const sourcePath = path.join(f.context.workDir, 'app.js');
  const sourceBefore = readFileSync(sourcePath);
  const stop = Error('Inspect dependency planning before execution');
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
  await assert.rejects(
    verifyRuntime({
      ...f.context,
      turnId: 'turn.attempt-5',
      browserCache: null,
      retryContext: null,
      docker: async (args, options = {}) => {
        const output =
          args[0] === 'run' ? JSON.stringify(capabilities) : 'removed';
        if (options.logPath) writeFileSync(options.logPath, output);
        return {
          exitCode: 0,
          timedOut: false,
          limited: false,
          output,
          logPath: options.logPath,
          logSha256: hash(output),
        };
      },
      step: async (stage, instruction) => {
        assert.equal(stage, 'runtime-plan');
        assert.match(
          instruction,
          /已确认 npm ci 因原产物 package\.json 与锁文件错配/,
        );
        assert.match(instruction, /完整项目复制到 \/tmp 的独立目录/);
        assert.match(
          instruction,
          /npm install --no-save --package-lock=false --ignore-scripts/,
        );
        assert.match(
          instruction,
          /禁止修改原项目或副本的源码、原测试、package\.json 和锁文件/,
        );
        assert.match(
          instruction,
          /安装前后必须核对这些原有文件的 SHA-256 不变/,
        );
        assert.match(instruction, /实际安装版本满足原声明范围及 Node 版本条件/);
        assert.match(instruction, /实际测试数大于 0、跳过数为 0/);
        assert.match(
          instruction,
          /保留清单错配及原 npm ci 失败日志，作为交付缺陷证据/,
        );
        assert.match(instruction, /不得声称锁文件干净安装通过/);
        assert.match(instruction, /测试仍未执行或被跳过，保持 blocked/);
        assert.match(
          instruction,
          /测试框架的真实结构化结果，或原生汇总与退出码/,
        );
        assert.match(
          instruction,
          /不要用匹配单行 test 名称加 \.\.\. ok 的正则推测数量/,
        );
        assert.match(
          instruction,
          /unittest 的测试文档字符串可把名称、说明和结果拆成多行/,
        );
        assert.match(
          instruction,
          /TestResult\.testsRun、failures、errors、skipped 及 wasSuccessful\(\)/,
        );
        assert.match(instruction, /保持原测试入口或原发现范围/);
        assert.match(instruction, /不虚构预期测试数/);
        assert.match(instruction, /未取得真实结果仍按 blocked 处理/);
        assert.match(instruction, /必须同时检查 signalCode/);
        assert.match(instruction, /清理函数可重复调用/);
        assert.match(instruction, /后续等待也必须有时限/);
        assert.match(instruction, /清理失败或超时仍是 blocked/);
        throw stop;
      },
    }),
    (error) => error === stop,
  );
  assert.deepEqual(readFileSync(sourcePath), sourceBefore);
  assert.equal(reuseRuntimeVerification(f.report, f.context), null);
});
