import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  prepareRuntimePlan,
  syntaxProbeProgram,
  runtimePathInstructions,
  assertKnownRuntimeChecks,
  knownRuntimeRequirements,
  browserLocatorContractIssues,
  runtimeScriptContractIssues,
} from '../scripts/runtime-plan-preflight.mjs';
import { validateCodeRef } from '../scripts/runtime-verification.mjs';
import diagnostics from '../scripts/runtime-browser-diagnostics.cjs';
import {
  runtimeBudgetRepairBase,
  applyRuntimeBudgetRepair,
} from '../lib/runtime-verification.mjs';

test('preflight catches calling locator methods on the async unique helper before execution', () => {
  const helper =
    'const { unique } = require("/opt/annotation/verification-browser.cjs");\n';
  for (const code of [
    "await unique(page.locator('#btn-sample')).click();",
    "const text = await unique(page.locator('#summary-bar')).innerText();",
    "const entry = unique(page.locator('#coverageLink')); await entry.click();",
  ])
    assert.equal(browserLocatorContractIssues(helper + code).length, 1, code);
  for (const code of [
    "const button = page.locator('#btn-sample'); await unique(button); await button.click();",
    "await (await unique(page.locator('#btn-sample'))).click();",
    "const entry = await unique(page.locator('#coverageLink')); await entry.click();",
    "const pending = unique(page.locator('#coverageLink')); await (await pending).click();",
  ])
    assert.deepEqual(browserLocatorContractIssues(helper + code), [], code);
  assert.deepEqual(
    browserLocatorContractIssues(
      'const entry = unique(locator); entry.click();',
    ),
    [],
  );
});

const check = {
  id: 'business',
  kind: 'acceptance',
  command: 'true',
  requirement: '显示实际结果',
  expected: '结果正确',
  codeEvidence: 'projects/p1/app.js:1',
  timeoutSeconds: 60,
};
test('budget patches preserve every original check byte-for-byte except the allocated timeout', () => {
  const base = {
    summary: '原计划',
    checks: Array.from({ length: 4 }, (_, i) => ({
      ...check,
      id: 'check' + i,
      timeoutSeconds: 300,
    })),
  };
  const before = structuredClone(base);
  const prior = {
    plan: { value: base },
    issues: [{ kind: 'structure', message: '独立验收总时限不能超过 15 分钟' }],
  };
  const frozen = runtimeBudgetRepairBase(prior);
  assert.deepEqual(frozen, base);
  const patch = {
    timeouts: [...base.checks]
      .reverse()
      .map((c) => ({ id: c.id, timeoutSeconds: 200 })),
  };
  const repaired = applyRuntimeBudgetRepair(frozen, patch);
  assert.deepEqual(repaired, {
    ...base,
    checks: base.checks.map((c) => ({ ...c, timeoutSeconds: 200 })),
  });
  assert.deepEqual(base, before);
  assert.deepEqual(frozen, before);
  for (const invalid of [
    { ...patch, summary: '重写说明' },
    { timeouts: patch.timeouts.slice(1) },
    {
      timeouts: patch.timeouts.map((x, i) =>
        i ? x : { ...x, id: 'new_check' },
      ),
    },
    { timeouts: patch.timeouts.map((x, i) => (i ? x : patch.timeouts[1])) },
    {
      timeouts: patch.timeouts.map((x) => ({ ...x, requirement: '换个说法' })),
    },
    { timeouts: patch.timeouts.map((x) => ({ ...x, expected: '忽略失败' })) },
    { timeouts: patch.timeouts.map((x) => ({ ...x, timeoutSeconds: 300 })) },
  ])
    assert.throws(() => applyRuntimeBudgetRepair(frozen, invalid));
  assert.equal(
    runtimeBudgetRepairBase({
      ...prior,
      issues: [...prior.issues, { message: '语法错误' }],
    }),
    null,
  );
  assert.equal(
    runtimeBudgetRepairBase({ ...prior, issues: [{ message: '路径不存在' }] }),
    null,
  );
});
test('preflight rejects named imports of the bundled CommonJS entry while allowing supported imports', () => {
  const entry = '/opt/annotation/node/node_modules/playwright/index.js';
  for (const code of [
    `import { chromium } from '${entry}';`,
    `import playwright, { chromium as browser } from "${entry}";`,
    `import {\n chromium,\n webkit,\n} from '${entry}';`,
  ])
    assert.match(runtimeScriptContractIssues(code).join(' '), /CommonJS/);
  for (const code of [
    `import playwright from '${entry}'; const { chromium } = playwright;`,
    `import { default as playwright } from '${entry}';`,
    `const { chromium } = require('${entry}');`,
    `import { chromium } from 'playwright';`,
    `import { chromium } from '/project/browser.mjs';`,
  ])
    assert.deepEqual(runtimeScriptContractIssues(code), [], code);
});

test('empty quoted wildcard matches valid zero-failure statistics and is caught before execution', () => {
  const bad =
    "case \"$tests:$pass:$fail:$skipped\" in\n  ''*|*'::'*) echo blocked ;;\n  *) echo valid ;;\nesac";
  const result = spawnSync(
    '/bin/bash',
    ['-c', 'tests=58; pass=58; fail=0; skipped=0;\n' + bad],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'blocked');
  assert.match(runtimeScriptContractIssues(bad).join(' '), /通配符/);
  assert.equal(
    runtimeScriptContractIssues(bad.replace("''*", '""*')).length,
    1,
  );
  assert.deepEqual(runtimeScriptContractIssues(bad.replace("''*", "''")), []);
});
test('known reproduced failures keep their business requirement and expected result in a new plan', () => {
  const history = { checks: [{ ...check, outcome: 'reproduced' }] };
  assert.doesNotThrow(() =>
    assertKnownRuntimeChecks({ checks: [check] }, history),
  );
  for (const checks of [
    [],
    [{ ...check, kind: 'setup' }],
    [{ ...check, expected: '忽略问题' }],
  ])
    assert.throws(
      () => assertKnownRuntimeChecks({ checks }, history),
      /已复现问题/,
    );
});
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'projects/p1'), { recursive: true });
  writeFileSync(path.join(root, 'projects/p1/app.js'), 'console.log(1);\n');
  return root;
}
function syntax(checks) {
  const r = spawnSync(
    process.execPath,
    ['-e', syntaxProbeProgram, JSON.stringify(checks)],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function setup(root, generate) {
  const calls = [];
  return {
    calls,
    options: {
      root,
      imageId: 'sha256:' + 'a'.repeat(64),
      generate,
      withHeavy: async (_kind, fn) => fn(),
      validateReferences: (p) =>
        p.checks.forEach((c) => validateCodeRef(c.codeEvidence, root)),
      docker: async (args, options) => {
        calls.push(args);
        assert.ok(args.includes('none'));
        assert.ok(args.includes('--read-only'));
        assert.ok(!args.includes('--mount'));
        const output = syntax(JSON.parse(args.at(-1)));
        writeFileSync(options.logPath, output);
        return {
          output,
          exitCode: 0,
          logPath: options.logPath,
          logSha256: createHash('sha256').update(output).digest('hex'),
        };
      },
    },
  };
}

test('script contract repair runs before syntax probing and preserves the original business check', async (t) => {
  const root = fixture(t),
    generated = [];
  const f = setup(root, async (revision, prior) => {
    generated.push(prior);
    return {
      value: {
        summary: 'verify',
        checks: [
          {
            ...check,
            command: revision
              ? "cat > /tmp/verify.mjs <<'JS'\nimport playwright from '/opt/annotation/node/node_modules/playwright/index.js';\nconst { chromium } = playwright;\nJS"
              : "cat > /tmp/verify.mjs <<'JS'\nimport { chromium } from '/opt/annotation/node/node_modules/playwright/index.js';\nJS",
          },
        ],
      },
    };
  });
  const plan = await prepareRuntimePlan(f.options);
  assert.equal(generated.length, 2);
  assert.equal(generated[1].issues[0].kind, 'script-contract');
  assert.equal(f.calls.length, 1);
  assert.equal(plan.value.checks[0].expected, check.expected);
  assert.equal(plan.value.checks[0].requirement, check.requirement);
  assert.equal(plan.preflight.revisions, 1);
});

test('real parsers reject shell and literal inline Python/JS syntax without executing any commands', (t) => {
  const root = fixture(t),
    sentinel = path.join(root, 'must-not-exist');
  const output = JSON.parse(
    syntax([
      { id: 'shell', command: 'if true; then' },
      { id: 'py', command: "cat > /tmp/check.py <<'PY'\nfor x in\nPY" },
      { id: 'js', command: "node <<'JS'\nconst x = ;\nJS" },
      {
        id: 'inline',
        command:
          "node --input-type=module -e \"await import('jsdom'); console.log('JSDOM existing='+((await import('jsdom')).JSDOM.name)\"",
      },
      {
        id: 'safe',
        command: `touch '${sentinel}'\nnode <<'JS'\nrequire('fs').writeFileSync('${sentinel}', 'bad')\nJS`,
      },
    ]),
  );
  assert.deepEqual(
    output.issues.map((x) => [x.id, x.language]),
    [
      ['shell', 'bash'],
      ['py', 'python'],
      ['js', 'javascript'],
      ['inline', 'javascript'],
    ],
  );
  assert.equal(existsSync(sentinel), false);
});

test('a missing project prefix is repaired once before commands execute and both plans stay on disk', async (t) => {
  const root = fixture(t),
    generated = [];
  const f = setup(root, async (revision, prior) => {
    generated.push({ revision, prior });
    return {
      tracePath: revision ? 'new-trace' : 'old-trace',
      value: {
        summary: 'verify',
        checks: [
          {
            ...check,
            codeEvidence: revision ? check.codeEvidence : 'app.js:1',
          },
        ],
      },
    };
  });
  const plan = await prepareRuntimePlan(f.options);
  assert.equal(generated.length, 2);
  assert.match(generated[1].prior.issues[0].message, /不存在/);
  assert.equal(f.calls.length, 1);
  assert.equal(plan.preflight.revisions, 1);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, 'preflight-0.json'))).attempts[0]
      .plan.value.checks[0].codeEvidence,
    'app.js:1',
  );
  assert.match(
    runtimePathInstructions({
      workDir: root,
      projectDirectory: 'projects/p1',
      files: [{ path: 'projects/p1/app.js' }],
    }),
    /cd \/workspace\/projects\/p1/,
  );
});

test('syntax repair preserves the business obligation, and a second failure stops', async (t) => {
  const root = fixture(t);
  let generated = 0;
  const f = setup(root, async () => {
    generated++;
    return {
      value: {
        summary: 'verify',
        checks: [{ ...check, command: 'if true; then' }],
      },
    };
  });
  await assert.rejects(prepareRuntimePlan(f.options), /修订后仍未通过/);
  assert.equal(generated, 2);
  assert.equal(f.calls.length, 2);
  const root2 = path.join(root, 'second');
  mkdirSync(root2);
  let count = 0;
  const altered = setup(root2, async () => ({
    value: {
      summary: 'verify',
      checks: [
        { ...check, expected: count++ ? '不再检查结果' : check.expected },
      ],
    },
  }));
  await assert.rejects(prepareRuntimePlan(altered.options), /改变原业务检查/);
  assert.equal(altered.calls.length, 0);
});

test('schema budget errors can be repaired without spending an execution attempt', async (t) => {
  const root = fixture(t);
  const invalid = {
    value: {
      summary: 'verify',
      checks: Array.from({ length: 4 }, (_, i) => ({
        ...check,
        id: 'check' + i,
        timeoutSeconds: 300,
      })),
    },
  };
  const f = setup(root, async (revision, prior) => {
    if (!revision) {
      const error = Error('独立验收总时限不能超过 15 分钟');
      error.runtimePlanCandidate = invalid;
      throw error;
    }
    return {
      value: applyRuntimeBudgetRepair(runtimeBudgetRepairBase(prior), {
        timeouts: invalid.value.checks.map((c) => ({
          id: c.id,
          timeoutSeconds: 200,
        })),
      }),
    };
  });
  const plan = await prepareRuntimePlan(f.options);
  assert.equal(plan.value.checks.length, 4);
  assert.deepEqual(
    plan.value.checks.map((c) => ({ ...c, timeoutSeconds: 300 })),
    invalid.value.checks,
  );
  assert.equal(f.calls.length, 1);
});

test('preflight repair restores exact verified history after a draft paraphrases it', async (t) => {
  const root = fixture(t);
  const history = { checks: [{ ...check, outcome: 'reproduced' }] };
  const f = setup(root, async (revision) => ({
    value: {
      summary: 'verify',
      checks: [
        { ...check, expected: revision ? check.expected : '改写过的预期' },
      ],
    },
  }));
  f.options.knownChecks = knownRuntimeRequirements(history);
  f.options.validateReferences = (plan) =>
    assertKnownRuntimeChecks(plan, history);
  const plan = await prepareRuntimePlan(f.options);
  assert.equal(plan.preflight.revisions, 1);
  assert.equal(plan.value.checks[0].expected, check.expected);
  assert.equal(f.calls.length, 1);
  const audit = JSON.parse(readFileSync(plan.preflight.reportPath));
  assert.equal(audit.attempts[0].plan.value.checks[0].expected, '改写过的预期');
});

test('preflight may append a missing verified check but cannot substitute an unrelated check', async (t) => {
  for (const unrelated of [false, true]) {
    const root = fixture(t);
    const historical = { ...check, id: 'old_failure', outcome: 'reproduced' };
    const history = { checks: [historical] };
    const f = setup(root, async (revision) => ({
      value: {
        summary: 'verify',
        checks: [
          check,
          ...(revision
            ? [{ ...historical, id: unrelated ? 'different' : historical.id }]
            : []),
        ],
      },
    }));
    f.options.knownChecks = knownRuntimeRequirements(history);
    f.options.validateReferences = (plan) =>
      assertKnownRuntimeChecks(plan, history);
    if (unrelated)
      await assert.rejects(prepareRuntimePlan(f.options), /改变原业务检查/);
    else {
      const plan = await prepareRuntimePlan(f.options);
      assert.deepEqual(
        plan.value.checks.map((c) => c.id),
        ['business', 'old_failure'],
      );
    }
  }
});

test('verified history cannot authorize weakening an existing obligation or promoting blocked checks', async (t) => {
  const root = fixture(t);
  const history = {
    checks: [
      { ...check, outcome: 'reproduced' },
      { ...check, id: 'blocked', outcome: 'blocked' },
    ],
  };
  assert.deepEqual(knownRuntimeRequirements(history), [
    { id: check.id, requirement: check.requirement, expected: check.expected },
  ]);
  const f = setup(root, async (revision) => ({
    value: {
      summary: 'verify',
      checks: [
        {
          ...check,
          command: revision ? 'true' : 'if true; then',
          expected: revision ? '不再检查' : check.expected,
        },
      ],
    },
  }));
  f.options.knownChecks = knownRuntimeRequirements(history);
  await assert.rejects(prepareRuntimePlan(f.options), /改变原业务检查/);
});

test('browser diagnostics retain the original error and never select a duplicate control', async () => {
  const locator = {
    first: () => ({ waitFor: async () => {} }),
    count: async () => 2,
  };
  await assert.rejects(diagnostics.unique(locator), /expected=1 actual=2/);
  const error = Error('business assertion failed'),
    messages = [];
  const old = console.log;
  console.log = (x) => messages.push(x);
  try {
    await assert.rejects(
      diagnostics.withPageDiagnostics(
        {
          locator: () => ({
            evaluateAll: async () => [{ tag: 'button', text: '保存' }],
          }),
        },
        async () => {
          throw error;
        },
      ),
      (e) => e === error,
    );
  } finally {
    console.log = old;
  }
  assert.match(messages[0], /保存/);
});

test('unique re-resolves a temporarily detached locator without selecting its first match', async () => {
  let waits = 0,
    counts = 0;
  const locator = {
    first: () => ({
      waitFor: async ({ timeout }) => {
        waits++;
        assert.ok(timeout > 0 && timeout <= 5000);
      },
    }),
    count: async () => (++counts === 1 ? 0 : 1),
  };
  assert.equal(await diagnostics.unique(locator), locator);
  assert.equal(waits, 2);
  assert.equal(counts, 2);
  counts = 0;
  locator.count = async () => (++counts === 1 ? 0 : 2);
  await assert.rejects(diagnostics.unique(locator), /expected=1 actual=2/);
});

test('unique keeps one total timeout and preserves a subsequent attachment failure', async () => {
  const timeouts = [],
    error = Error('attachment timeout');
  const locator = {
    first: () => ({
      waitFor: async ({ timeout }) => {
        timeouts.push(timeout);
        if (timeouts.length > 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 15));
      },
    }),
    count: async () => 0,
  };
  await assert.rejects(diagnostics.unique(locator), (e) => e === error);
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] < timeouts[0]);
});
