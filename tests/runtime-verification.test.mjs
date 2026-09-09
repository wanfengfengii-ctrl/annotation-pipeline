import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  existsSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  validateRuntimePlan,
  runtimeRepairEvidence,
  runtimeVersion,
} from '../lib/runtime-verification.mjs';
import {
  copyVerificationSource,
  finalizeRuntimeReport,
  validateCodeRef,
  runtimeInputDigest,
  reuseRuntimeVerification,
  runtimeCommandArgs,
  probeRuntimeEnvironment,
  verifyRuntime,
} from '../scripts/runtime-verification.mjs';
import { schemas } from '../scripts/codex-stages.mjs';
const spec = {
  id: 'api',
  kind: 'acceptance',
  command: 'python3 /tmp/check.py',
  expected: 'total=4',
  requirement: '计算总数',
  codeEvidence: 'app.py:1',
  timeoutSeconds: 10,
};
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const probeCapabilities = {
  commands: {
    bash: true,
    node: true,
    npm: true,
    python3: true,
    pip: false,
    pip3: false,
    'apt-get': true,
    apk: false,
    dnf: false,
    yum: false,
    chromium: false,
    'chromium-browser': false,
    'google-chrome': false,
    firefox: false,
  },
  pythonModules: {
    venv: true,
    ensurepip: false,
    pip: false,
    playwright: false,
  },
};
function dockerResult(output, options = {}, patch = {}) {
  if (options.logPath) writeFileSync(options.logPath, output);
  return {
    exitCode: 0,
    timedOut: false,
    limited: false,
    output,
    logPath: options.logPath,
    logSha256: createHash('sha256').update(output).digest('hex'),
    ...patch,
  };
}
function runVerificationShell(command, options = {}) {
  const args = runtimeCommandArgs('verification-test', command),
    shellIndex = args.indexOf('/bin/bash'),
    env = { ...process.env, ...options.env };
  for (let i = 0; i < shellIndex; i++) {
    if (args[i] !== '--env') continue;
    const [key, value] = args[++i].split('=');
    env[key] = value;
  }
  return spawnSync(args[shellIndex], args.slice(shellIndex + 1), {
    cwd: options.cwd,
    env,
    encoding: 'utf8',
  });
}
test('Verification shell supports Bash ERR traps and pipefail without misclassifying setup failures', () => {
  const result = runVerificationShell(`set -Ee -o pipefail
trap 'printf "setup failed: status=%s\\n" "$?"; exit 2' ERR
false | true
printf 'unreachable\\n'`);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, 'setup failed: status=1\n');
  assert.equal(result.stderr, '');
});
test('Verification preserves multiline commands and literal quoting as one argument', () => {
  const payload =
      'quotes "double" \'single\' $HOME $(printf substituted) `printf substituted`',
    command = `cat <<'EXACT_COMMAND_PAYLOAD'\n${payload}\nEXACT_COMMAND_PAYLOAD\nprintf '%s\\n' 'last line'`;
  const args = runtimeCommandArgs('verification-test', command);
  assert.deepEqual(args.slice(-5), [
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-c',
    command,
  ]);
  const result = runVerificationShell(command);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, payload + '\nlast line\n');
  assert.equal(result.stderr, '');
});
test('Verification ignores shell startup files and previous steps exported variables', (t) => {
  const dir = fixture(t),
    startup = path.join(dir, 'injected startup.sh');
  for (const file of [startup, '.bash_profile', '.bashrc', '.profile'])
    writeFileSync(
      path.isAbsolute(file) ? file : path.join(dir, file),
      "printf 'unexpected startup file\\n'; exit 91\n",
    );
  const options = {
    cwd: dir,
    env: { HOME: dir, BASH_ENV: startup, ENV: startup },
  };
  const first = runVerificationShell(
    "export ANNOTATION_PREVIOUS_STEP=present; printf 'ready\\n'",
    options,
  );
  assert.equal(first.status, 0);
  assert.equal(first.stdout, 'ready\n');
  const next = runVerificationShell(
    'printf \'%s|%s|%s\\n\' "${BASH_ENV-unset}" "${ENV-unset}" "${ANNOTATION_PREVIOUS_STEP-unset}"',
    options,
  );
  assert.equal(next.status, 0);
  assert.equal(next.stdout, '||unset\n');
  assert.equal(next.stderr, '');
});
test('Runtime planning receives measured capabilities and Bash contract after isolated probe cleanup', async (t) => {
  const dir = fixture(t),
    workDir = path.join(dir, 'source');
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, 'app.js'), 'export const value = 1;\n');
  const stopAfterPlan = new Error('stop after checking planner instructions');
  const calls = [];
  await assert.rejects(
    verifyRuntime({
      browserCache: null,
      dir,
      workDir,
      turnId: 'turn',
      imageId: 'sha256:' + 'a'.repeat(64),
      prompt: '显示结果',
      acceptance: ['result=1'],
      docker: async (args, options) => {
        calls.push(args);
        assert.equal(calls.length <= 2, true);
        return dockerResult(
          args[0] === 'run' ? JSON.stringify(probeCapabilities) : 'removed',
          options,
        );
      },
      step: async (stage, instruction, cwd) => {
        assert.equal(stage, 'runtime-plan');
        assert.equal(cwd, workDir);
        assert.match(instruction, /\/bin\/bash --noprofile --norc -c/);
        assert.match(instruction, /BASH_ENV 和 ENV 清空/);
        assert.match(instruction, /上一检查步骤 export 的环境变量不会继承/);
        assert.match(instruction, /"venv":true,"ensurepip":false/);
        assert.match(instruction, /"node":true,"npm":true/);
        assert.match(instruction, /不能直接依赖 python3 -m venv/);
        assert.match(instruction, /npm 在 \/tmp 下的独立目录安装 Playwright/);
        assert.match(instruction, /真实启动 headless 浏览器验证/);
        assert.match(instruction, /安装或启动失败属于环境 blocked/);
        assert.match(instruction, /先读取真实启动入口和依赖引用/);
        assert.match(instruction, /不要无条件执行 npm ci/);
        assert.match(instruction, /不修改源码、依赖清单或锁文件/);
        assert.match(instruction, /保留不一致和安装失败证据/);
        assert.match(instruction, /自带测试执行状态，尚未运行时明确写未执行/);
        assert.match(instruction, /不强制所有项目使用 Playwright/);
        assert.match(instruction, /playwright install --only-shell chromium/);
        assert.match(
          instruction,
          /系统依赖安装与浏览器二进制下载拆成不同 setup/,
        );
        assert.match(instruction, /为实际业务 acceptance 留出时间预算/);
        assert.equal(calls.length, 2);
        assert.equal(calls[1][0], 'rm');
        throw stopAfterPlan;
      },
    }),
    (error) => error === stopAfterPlan,
  );
});
test('Environment probe is bounded, has no mounts or network, and removes its exact container', async (t) => {
  const root = fixture(t),
    calls = [],
    imageId = 'sha256:' + 'a'.repeat(64);
  const probe = await probeRuntimeEnvironment({
    imageId,
    root,
    docker: async (args, options = {}) => {
      calls.push({ args, options });
      return dockerResult(
        args[0] === 'run' ? JSON.stringify(probeCapabilities) : 'removed',
        options,
      );
    },
  });
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--memory') + 1], '128m');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '64');
  assert.equal(args[args.indexOf('--cpus') + 1], '0.25');
  assert(args.includes('--read-only'));
  assert(args.includes('BASH_ENV='));
  assert(args.includes('ENV='));
  assert(
    !args.some((a) => ['--mount', '-v', '--volume', '--env-file'].includes(a)),
  );
  assert.equal(calls[0].options.timeoutSeconds, 30);
  assert.deepEqual(calls[1].args, [
    'rm',
    '--force',
    args[args.indexOf('--name') + 1],
  ]);
  assert.deepEqual(probe.capabilities, probeCapabilities);
  assert.equal(probe.imageId, imageId);
  assert.equal(
    probe.logSha256,
    createHash('sha256').update(readFileSync(probe.logPath)).digest('hex'),
  );
});
test('Probe failures leave capabilities unknown, skip planning and always attempt cleanup', async (t) => {
  const dir = fixture(t),
    workDir = path.join(dir, 'source');
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, 'app.js'), 'export const value = 1;\n');
  for (const failure of [
    { exitCode: 2 },
    { timedOut: true },
    { limited: true },
    { output: '{invalid' },
  ]) {
    const calls = [];
    await assert.rejects(
      verifyRuntime({
        browserCache: null,
        dir,
        workDir,
        turnId: 'turn',
        imageId: 'sha256:' + 'a'.repeat(64),
        prompt: '显示结果',
        acceptance: ['result=1'],
        docker: async (args, options) => {
          calls.push(args);
          return dockerResult(
            args[0] === 'run' ? JSON.stringify(probeCapabilities) : 'removed',
            options,
            args[0] === 'run' ? failure : {},
          );
        },
        step: async () =>
          assert.fail('A failed probe must not reach the planner'),
      }),
      /环境能力未知/,
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], [
      'rm',
      '--force',
      calls[0][calls[0].indexOf('--name') + 1],
    ]);
  }
});
test('Probe cleanup is attempted when Docker throws and cleanup failure stays visible', async (t) => {
  const root = fixture(t),
    imageId = 'sha256:' + 'a'.repeat(64),
    calls = [];
  await assert.rejects(
    probeRuntimeEnvironment({
      root,
      imageId,
      docker: async (args) => {
        calls.push(args);
        if (args[0] === 'run') throw Error('Docker unavailable');
        return dockerResult('No such container', {}, { exitCode: 1 });
      },
    }),
    /环境能力未知/,
  );
  assert.equal(calls.length, 2);
  await assert.rejects(
    probeRuntimeEnvironment({
      root,
      imageId,
      docker: async (args, options) =>
        args[0] === 'run'
          ? dockerResult(JSON.stringify(probeCapabilities), options)
          : dockerResult('cannot remove', {}, { exitCode: 1 }),
    }),
    /探测容器清理失败/,
  );
});
test('The actual fixture CLI supplies the same probe contract without launching Docker', async (t) => {
  const root = fixture(t),
    cli = path.join(root, 'docker');
  copyFileSync('tests/fixtures/pipeline-cli.cjs', cli);
  copyFileSync('tests/fixtures/question.cjs', path.join(root, 'question.cjs'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}');
  const probe = await probeRuntimeEnvironment({
    root,
    imageId: 'sha256:' + 'a'.repeat(64),
    docker: async (args, options) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env: { PATH: process.env.PATH, FIXTURE_BIN: root },
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return dockerResult(result.stdout, options);
    },
  });
  assert.deepEqual(probe.capabilities, probeCapabilities);
});
test('Runtime plans require real acceptance, unique IDs and bounded execution', () => {
  assert.equal(
    validateRuntimePlan({ summary: 'check', checks: [spec] }).checks.length,
    1,
  );
  for (const checks of [
    [],
    [spec, spec],
    [{ ...spec, kind: 'setup' }],
    [{ ...spec, timeoutSeconds: 301 }],
    Array.from({ length: 8 }, (_, i) => ({
      ...spec,
      id: 'c' + i,
      timeoutSeconds: 300,
    })),
  ])
    assert.throws(() => validateRuntimePlan({ summary: 'check', checks }));
});
test('Descriptive check IDs follow the same bounded contract in generation and validation', () => {
  const pattern = new RegExp(
    schemas['runtime-plan'].properties.checks.items.properties.id.pattern,
  );
  for (const id of [
    'reproduction_expiry_during_database_lock_wait',
    'a'.repeat(128),
  ]) {
    assert(pattern.test(id));
    assert.doesNotThrow(() =>
      validateRuntimePlan({ summary: 'check', checks: [{ ...spec, id }] }),
    );
  }
  for (const id of [
    'a'.repeat(129),
    '../escape',
    'with/slash',
    'uppercaseID',
    '1check',
    '',
  ]) {
    assert(!pattern.test(id));
    assert.throws(
      () =>
        validateRuntimePlan({ summary: 'check', checks: [{ ...spec, id }] }),
      /步骤格式/,
    );
  }
  assert.throws(
    () => validateRuntimePlan({ summary: 'check', checks: [null] }),
    /步骤格式/,
  );
});
test('Every source reference is verified, including lists, line bounds and directory symlinks', (t) => {
  const dir = fixture(t),
    source = path.join(dir, 'source'),
    outside = path.join(dir, 'outside');
  mkdirSync(source);
  mkdirSync(outside);
  writeFileSync(path.join(source, 'app.py'), 'first\nsecond');
  writeFileSync(path.join(source, 'worker.py'), 'worker');
  writeFileSync(path.join(outside, 'secret.py'), 'secret');
  symlinkSync(outside, path.join(source, 'link'));
  for (const refs of [
    'app.py:1',
    'app.py:1; worker.py:1',
    'app.py:2；worker.py:1',
  ])
    assert.doesNotThrow(() => validateCodeRef(refs, source));
  for (const refs of [
    'app.py:1; missing.py:1',
    'app.py:1; worker.py:99',
    'app.py:0',
    'app.py:1;',
    '../outside/secret.py:1',
    'link/secret.py:1',
    `${source}/app.py:1`,
    Array(9).fill('app.py:1').join(';'),
  ])
    assert.throws(() => validateCodeRef(refs, source));
});
test('Verification copy omits secrets and symlinks and never edits original', (t) => {
  const dir = fixture(t),
    src = path.join(dir, 'source'),
    dest = path.join(dir, 'copy');
  mkdirSync(src);
  writeFileSync(path.join(src, 'app.py'), 'print(1)');
  writeFileSync(path.join(src, '.env'), 'SECRET');
  symlinkSync('/etc/passwd', path.join(src, 'escape'));
  const m = copyVerificationSource(src, dest);
  assert.equal(m.files.length, 1);
  assert(!existsSync(path.join(dest, '.env')));
  assert(!existsSync(path.join(dest, 'escape')));
  writeFileSync(path.join(dest, 'app.py'), 'print(2)');
  assert.equal(readFileSync(path.join(src, 'app.py'), 'utf8'), 'print(1)');
});
test('Completed verification is reusable only for identical inputs, source and intact evidence', (t) => {
  const dir = fixture(t),
    workDir = path.join(dir, 'source'),
    runDir = path.join(dir, 'turn.attempt-1.runtime');
  mkdirSync(workDir);
  mkdirSync(runDir);
  writeFileSync(path.join(workDir, 'app.py'), 'print(1)');
  const context = {
    dir,
    workDir,
    turnId: 'turn',
    taskId: 'task',
    imageId: 'sha256:' + 'a'.repeat(64),
    prompt: 'original',
    acceptance: ['result=4'],
  };
  const logPath = path.join(runDir, 'api.log');
  writeFileSync(logPath, 'expected=4 actual=3\n');
  const run = {
    id: 'api',
    exitCode: 1,
    timedOut: false,
    limited: false,
    sourceChanged: false,
    logPath,
    logSha256: createHash('sha256').update(readFileSync(logPath)).digest('hex'),
  };
  const plan = {
    value: { summary: 'check', checks: [spec] },
    tracePath: path.join(dir, 'plan.jsonl'),
  };
  const diagnosis = {
    value: {
      summary: 'bug',
      checks: [
        {
          id: 'api',
          outcome: 'reproduced',
          observed: '3 instead of 4',
          evidenceLine: 1,
        },
      ],
    },
    tracePath: path.join(dir, 'diagnosis.jsonl'),
  };
  const executionPath = path.join(runDir, 'execution.json'),
    reportPath = path.join(runDir, 'report.json');
  writeFileSync(plan.tracePath, '{}\n');
  writeFileSync(diagnosis.tracePath, '{}\n');
  writeFileSync(
    executionPath,
    JSON.stringify({ plan: plan.value, runs: [run] }),
  );
  const report = {
    ...finalizeRuntimeReport(plan.value, [run], diagnosis.value),
    imageId: context.imageId,
    inputDigest: runtimeInputDigest(context),
    sourceManifest: copyVerificationSource(workDir),
    plan,
    diagnosis,
    executionPath,
    reportPath,
  };
  function saved(value) {
    writeFileSync(reportPath, JSON.stringify(value));
    return {
      ...value,
      reportSha256: createHash('sha256')
        .update(readFileSync(reportPath))
        .digest('hex'),
    };
  }
  const current = saved(report);
  assert.equal(reuseRuntimeVerification(current, context), current);
  for (const patch of [
    { prompt: 'changed' },
    { acceptance: ['changed'] },
    { imageId: 'different' },
    { turnId: 'other' },
  ])
    assert.equal(
      reuseRuntimeVerification(current, { ...context, ...patch }),
      null,
    );
  assert.equal(
    reuseRuntimeVerification({ ...current, status: 'passed' }, context),
    null,
  );
  writeFileSync(path.join(workDir, 'new.py'), 'new');
  assert.equal(reuseRuntimeVerification(current, context), null);
  rmSync(path.join(workDir, 'new.py'));
  writeFileSync(logPath, 'tampered');
  assert.equal(reuseRuntimeVerification(current, context), null);
  writeFileSync(logPath, 'expected=4 actual=3\n');
  const execution = readFileSync(executionPath);
  writeFileSync(
    executionPath,
    JSON.stringify({ plan: plan.value, runs: [{ ...run, exitCode: 0 }] }),
  );
  assert.equal(reuseRuntimeVerification(current, context), null);
  writeFileSync(executionPath, execution);
  const { inputDigest, ...legacy } = report;
  const old = saved(legacy);
  assert.equal(reuseRuntimeVerification(old, context), null);
  const receipt = {
    taskId: 'task',
    turnId: 'turn',
    evaluationPrompt: context.prompt,
    container: { imageId: context.imageId },
    automation: {
      runtimeVerification: old,
      preparation: { value: { acceptance: context.acceptance } },
    },
  };
  assert.equal(
    reuseRuntimeVerification(old, { ...context, previousResult: receipt }),
    old,
  );
  assert.equal(
    reuseRuntimeVerification(old, {
      ...context,
      previousResult: { ...receipt, evaluationPrompt: 'changed' },
    }),
    null,
  );
  const probeLog = path.join(runDir, 'environment-probe.log');
  writeFileSync(probeLog, JSON.stringify(probeCapabilities));
  const withProbe = saved({
    ...report,
    environmentProbe: {
      version: '2026-09-10.env1',
      imageId: context.imageId,
      capabilities: probeCapabilities,
      logPath: probeLog,
      logSha256: createHash('sha256')
        .update(readFileSync(probeLog))
        .digest('hex'),
    },
  });
  assert.equal(reuseRuntimeVerification(withProbe, context), withProbe);
  writeFileSync(probeLog, '{}');
  assert.equal(reuseRuntimeVerification(withProbe, context), null);
  writeFileSync(probeLog, JSON.stringify(probeCapabilities));
  const differentProbeImage = saved({
    ...report,
    environmentProbe: { ...withProbe.environmentProbe, imageId: 'different' },
  });
  assert.equal(reuseRuntimeVerification(differentProbeImage, context), null);
  const differentCapabilities = saved({
    ...report,
    environmentProbe: {
      ...withProbe.environmentProbe,
      capabilities: {
        ...probeCapabilities,
        pythonModules: { ...probeCapabilities.pythonModules, ensurepip: true },
      },
    },
  });
  assert.equal(reuseRuntimeVerification(differentCapabilities, context), null);
  const outsideProbeLog = path.join(fixture(t), 'environment-probe.log');
  copyFileSync(probeLog, outsideProbeLog);
  const outsideProbe = saved({
    ...report,
    environmentProbe: {
      ...withProbe.environmentProbe,
      logPath: outsideProbeLog,
    },
  });
  assert.equal(reuseRuntimeVerification(outsideProbe, context), null);
});
test('Setup dependency failure remains blocked with bound probe evidence and untouched original source', async (t) => {
  const dir = fixture(t),
    workDir = path.join(dir, 'source'),
    calls = [],
    setup = {
      ...spec,
      id: 'setup_browser',
      kind: 'setup',
      codeEvidence: '无',
      command: 'prepare test browser',
    };
  mkdirSync(workDir);
  writeFileSync(path.join(workDir, 'app.py'), 'print(1)\n');
  const toolsRoot = path.join(dir, 'cache');
  mkdirSync(toolsRoot);
  writeFileSync(path.join(toolsRoot, 'ready.json'), '{}');
  writeFileSync(path.join(toolsRoot, 'build.log'), 'cache smoke passed');
  const browserCache = {
    root: toolsRoot,
    imageId: 'sha256:' + 'a'.repeat(64),
    platform: 'linux/arm64',
    toolVersion: '1.55.0',
    mountPath: '/opt/annotation-runtime-tools',
    modulePath: '/opt/annotation-runtime-tools/tools/node_modules/playwright',
    browsersPath: '/opt/annotation-runtime-tools/browsers',
    manifestPath: path.join(toolsRoot, 'ready.json'),
    manifestSha256: dockerResult('{}').logSha256,
    preparation: {
      logPath: path.join(toolsRoot, 'build.log'),
      logSha256: dockerResult('cache smoke passed').logSha256,
    },
  };
  const report = await verifyRuntime({
    browserCache,
    dir,
    workDir,
    turnId: 'turn',
    imageId: 'sha256:' + 'a'.repeat(64),
    prompt: '显示结果',
    acceptance: ['result=1'],
    docker: async (args, options) => {
      calls.push(args);
      if (args.includes('annotation.verification-probe=true'))
        return dockerResult(JSON.stringify(probeCapabilities), options);
      if (args[0] === 'exec')
        return dockerResult(
          'ENVIRONMENT_BLOCKED: browser download failed\n',
          options,
          {
            exitCode: 2,
          },
        );
      return dockerResult('container', options);
    },
    step: async (stage, instruction) => {
      if (stage === 'runtime-running') return;
      if (stage === 'runtime-plan') {
        assert.match(instruction, /Playwright 1\.55\.0/);
        assert.match(instruction, /不在题目内重新下载/);
        assert.match(instruction, /只读缓存不能安装、更新或清理/);
        assert.doesNotMatch(
          instruction,
          /优先通过 npm 在 \/tmp 下的独立目录安装 Playwright/,
        );
        assert.doesNotMatch(
          instruction,
          /playwright install --only-shell chromium/,
        );
      }
      const tracePath = path.join(dir, stage + '.jsonl');
      writeFileSync(tracePath, '{}\n');
      return {
        tracePath,
        value:
          stage === 'runtime-plan'
            ? { summary: 'prepare then test', checks: [setup, spec] }
            : {
                summary:
                  'browser dependency unavailable; business checks not run',
                checks: [
                  {
                    id: setup.id,
                    outcome: 'blocked',
                    observed: 'browser download failed',
                    evidenceLine: 1,
                  },
                ],
              },
      };
    },
  });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.environmentProbe.capabilities, probeCapabilities);
  const start = calls.find((args) =>
    args.includes('annotation.verification=true'),
  );
  assert(
    start.includes(
      `type=bind,source=${toolsRoot},target=/opt/annotation-runtime-tools,readonly`,
    ),
  );
  assert(
    start.includes(
      'PLAYWRIGHT_BROWSERS_PATH=/opt/annotation-runtime-tools/browsers',
    ),
  );
  for (const [fileKey, hashKey] of [
    ['recordPath', 'recordSha256'],
    ['manifestPath', 'manifestSha256'],
    ['buildLogPath', 'buildLogSha256'],
  ]) {
    const evidence = report.environmentProbe.browserCache;
    assert(
      evidence[fileKey].startsWith(path.dirname(report.reportPath) + path.sep),
    );
    assert.equal(
      createHash('sha256')
        .update(readFileSync(evidence[fileKey]))
        .digest('hex'),
      evidence[hashKey],
    );
  }
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].outcome, 'blocked');
  assert.equal(calls.filter((args) => args[0] === 'exec').length, 1);
  assert.equal(calls.at(-1)[0], 'rm');
  assert.equal(
    readFileSync(path.join(workDir, 'app.py'), 'utf8'),
    'print(1)\n',
  );
  const saved = JSON.parse(readFileSync(report.reportPath, 'utf8'));
  assert.deepEqual(saved.environmentProbe, report.environmentProbe);
  assert.equal(
    report.reportSha256,
    createHash('sha256').update(readFileSync(report.reportPath)).digest('hex'),
  );
  assert.throws(() =>
    finalizeRuntimeReport(report.plan.value, report.checks, {
      summary: 'incorrect business verdict',
      checks: [
        {
          id: setup.id,
          outcome: 'reproduced',
          observed: 'missing browser',
          evidenceLine: 1,
        },
      ],
    }),
  );
});
test('Diagnosis requires real failed assertions and valid immutable logs', (t) => {
  const dir = fixture(t),
    logPath = path.join(dir, 'api.log'),
    output = 'expected=4 actual=3\nAssertionError\n';
  writeFileSync(logPath, output);
  const plan = { summary: 'check', checks: [spec] },
    run = {
      id: 'api',
      exitCode: 1,
      timedOut: false,
      sourceChanged: false,
      limited: false,
      logPath,
      logSha256: createHash('sha256').update(output).digest('hex'),
    };
  const verdict = {
    summary: 'wrong result',
    checks: [
      {
        id: 'api',
        outcome: 'reproduced',
        observed: '3 instead of 4',
        evidenceLine: 1,
      },
    ],
  };
  const r = finalizeRuntimeReport(plan, [run], verdict);
  assert.equal(r.status, 'bugs');
  assert(
    runtimeRepairEvidence({
      automation: {
        runtimeVerification: {
          ...r,
          reportPath: '/report',
          reportSha256: 'hash',
        },
      },
    }),
  );
  for (const patch of [
    { exitCode: 0 },
    { exitCode: 2 },
    { timedOut: true },
    { sourceChanged: true },
    { limited: true },
    { exitCode: null },
  ])
    assert.throws(() =>
      finalizeRuntimeReport(plan, [{ ...run, ...patch }], verdict),
    );
  assert.throws(() =>
    finalizeRuntimeReport(plan, [run], {
      ...verdict,
      checks: [{ ...verdict.checks[0], id: 'invented' }],
    }),
  );
  assert.throws(() =>
    finalizeRuntimeReport(plan, [run], {
      ...verdict,
      checks: [{ ...verdict.checks[0], evidenceLine: 99 }],
    }),
  );
  const blocked = finalizeRuntimeReport(plan, [{ ...run, timedOut: true }], {
    ...verdict,
    checks: [{ ...verdict.checks[0], outcome: 'blocked' }],
  });
  assert.equal(blocked.status, 'blocked');
  assert(
    !runtimeRepairEvidence({
      automation: {
        runtimeVerification: {
          ...blocked,
          reportPath: '/report',
          reportSha256: 'hash',
        },
      },
    }),
  );
  writeFileSync(logPath, 'changed');
  assert.throws(() => finalizeRuntimeReport(plan, [run], verdict));
});
test('Passed checks and unconfirmed static suspicions cannot create Bug tasks', (t) => {
  const dir = fixture(t),
    logPath = path.join(dir, 'api.log');
  writeFileSync(logPath, 'OK');
  const run = {
    id: 'api',
    exitCode: 0,
    timedOut: false,
    logPath,
    logSha256: createHash('sha256').update('OK').digest('hex'),
  };
  for (const outcome of ['passed', 'not_reproduced']) {
    const r = finalizeRuntimeReport(
      { summary: 'check', checks: [spec] },
      [run],
      {
        summary: 'ok',
        checks: [{ id: 'api', outcome, observed: 'OK', evidenceLine: 1 }],
      },
    );
    assert.equal(r.status, 'passed');
    assert(
      !runtimeRepairEvidence({
        automation: { runtimeVerification: { ...r, version: runtimeVersion } },
      }),
    );
  }
});

test('Automatic follow-up binds a Bug to reproduced checks and prioritizes repair', async () => {
  const { repairDecision } = await import('../lib/project-series.mjs');
  const { nextDecision } = await import('../lib/workflow.mjs');
  const turn = {
    id: 'a',
    questionRootId: 'a',
    status: 'review',
    category: '0-1 代码生成',
    difficulty: '中等',
    claudeAttempts: ['one'],
    prompt: '原题',
    automation: {
      runtimeVersion,
      runtimeVerification: {
        version: runtimeVersion,
        executed: true,
        status: 'bugs',
        reportPath: '/report',
        reportSha256: 'hash',
        checks: [
          {
            id: 'api',
            kind: 'acceptance',
            exitCode: 1,
            timedOut: false,
            outcome: 'reproduced',
            logPath: '/log',
            logSha256: 'hash',
            requirement: '计算结果正确',
            codeEvidence: 'app.py:1',
          },
        ],
      },
    },
  };
  const task = { turns: [turn] },
    decision = {
      action: 'repair',
      prompt: '计算结果少了一，把这个问题修好',
      reason: '独立检查已复现',
      repairCheckIds: ['api'],
    };
  assert.equal(repairDecision(task, turn, decision).repairOf, 'a');
  assert.throws(
    () =>
      repairDecision(task, turn, { ...decision, repairCheckIds: ['invented'] }),
    /检查 ID/,
  );
  turn.automation.next = {
    value: { action: 'complete', prompt: '无', reason: 'done' },
  };
  assert.throws(
    () => nextDecision(task, turn, { autoContinue: true }),
    /必须先/,
  );
  turn.automation.runtimeVerification.status = 'passed';
  assert.throws(() => repairDecision(task, turn, decision), /复现证据/);
});
