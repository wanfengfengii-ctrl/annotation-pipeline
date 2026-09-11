#!/usr/bin/env node
const fs = require('fs'),
  path = require('path'),
  a = process.argv.slice(2),
  name = path.basename(process.argv[1]),
  sha = 'a'.repeat(40),
  dir = process.env.FIXTURE_BIN;
const { question, categoryQuestion, questionAudit } = require('./question.cjs');
if (a.includes('--version')) {
  console.log(name + ' fixture');
  process.exit(0);
}
if (
  name === 'docker' &&
  process.argv.some((arg) => arg.includes('ANNOTATION_ENV_READY'))
) {
  console.log(
    'ANNOTATION_READINESS=' +
      JSON.stringify({
        passed: true,
        uid: 1000,
        browser: true,
        venv: true,
        writableCaches: true,
        systemAptCleanupDisabled: true,
        caches: {
          npm_config_cache: '/home/node/.cache/annotation/npm',
          PIP_CACHE_DIR: '/home/node/.cache/annotation/pip',
          XDG_CACHE_HOME: '/home/node/.cache/annotation/xdg',
        },
        scaffold: true,
        dependencies: [],
      }),
  );
  process.exit(0);
}
if (name === 'docker') {
  if (a[0] === 'run' && a.includes('annotation.verification-preflight=true')) {
    console.log(JSON.stringify({ version: 1, issues: [] }));
    process.exit(0);
  }
  if (a[0] === 'run' && a.includes('annotation.verification-probe=true')) {
    console.log(
      JSON.stringify({
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
      }),
    );
    process.exit(0);
  }
  const GiB = 2 ** 30,
    memoryLimitBytes =
      (process.env.RUNNER_RESOURCE_PROFILE === 'lightweight' ? 1.5 : 3) * GiB,
    root = process.env.RUNNER_WORK_ROOT,
    owner = root
      ? require('crypto')
          .createHash('sha256')
          .update(fs.realpathSync(root))
          .digest('hex')
          .slice(0, 24)
      : '',
    containers = root
      ? fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
          const file = path.join(root, entry.name, 'container.json');
          if (!entry.isDirectory() || !fs.existsSync(file)) return [];
          const state = JSON.parse(fs.readFileSync(file, 'utf8'));
          return state.status === 'running'
            ? [
                {
                  id: state.containerId,
                  owner,
                  memoryLimitBytes,
                  workingSetBytes: 200 * 2 ** 20,
                },
              ]
            : [];
        })
      : [];
  containers.push({
    id: 'e'.repeat(64),
    owner: '',
    memoryLimitBytes: 0,
    workingSetBytes: 1.3 * GiB,
  });
  const logResourceCall = (action) => {
    if (process.env.FIXTURE_LOG)
      fs.appendFileSync(
        process.env.FIXTURE_LOG,
        JSON.stringify({ name: 'docker-resource', action, time: Date.now() }) +
          '\n',
      );
  };
  if (a[0] === 'ps') {
    logResourceCall('ps');
    console.log(containers.map((container) => container.id).join('\n'));
    process.exit(0);
  }
  if (a[0] === 'inspect' && a.includes('--format')) {
    logResourceCall('inspect');
    console.log(
      containers
        .filter((container) => a.includes(container.id))
        .map(({ id, owner, memoryLimitBytes }) =>
          JSON.stringify({ id, owner, memoryLimitBytes }),
        )
        .join('\n'),
    );
    process.exit(0);
  }
  if (a[0] === 'stats') {
    logResourceCall('stats');
    console.log(
      containers
        .filter((container) => a.includes(container.id))
        .map((container) =>
          JSON.stringify({
            ID: container.id.slice(0, 12),
            MemUsage: `${container.workingSetBytes / GiB}GiB / ${container.memoryLimitBytes / GiB || 8}GiB`,
          }),
        )
        .join('\n'),
    );
    process.exit(0);
  }
  if (a[0] === 'exec') {
    if (a.at(-1).includes('ANNOTATION_RESOURCE_SAMPLE')) {
      logResourceCall('vm-sample');
      console.log(
        JSON.stringify({
          memAvailableBytes: (6.2 - (containers.length - 1) * 0.2) * GiB,
          pressure: { someAvg10: 0, fullAvg10: 0 },
          cgroup: {
            currentBytes: 200 * 2 ** 20,
            maxBytes: memoryLimitBytes,
            inactiveFileBytes: 0,
          },
        }),
      );
      process.exit(0);
    }
    const bug = a.at(-1).includes('__runtime_bug__');
    console.log(
      bug
        ? 'synthetic assertion expected=4 actual=3'
        : 'synthetic runtime check passed',
    );
    process.exit(bug ? 1 : 0);
  }
  console.log(
    JSON.stringify(
      a[0] === 'info'
        ? {
            NCPU: 10,
            MemTotal: Number(process.env.FIXTURE_DOCKER_GB || 8) * 2 ** 30,
          }
        : [
            {
              Id: 'sha256:' + 'a'.repeat(64),
              Architecture: 'arm64',
              RepoDigests: [],
              Config: {
                User: 'node',
                WorkingDir: '/workspace',
                Entrypoint: ['/usr/local/bin/entrypoint.sh'],
                Cmd: ['interactive'],
                Labels: {
                  'annotation.pipeline.base-image':
                    'adminfather/benzhi-claude-code:20260909-isolated-git',
                  'annotation.pipeline.base-digest':
                    'sha256:f77014d9e56cd3db2ac96627a286814cb1aa9f0b4bb807bea98a01383c9bc4d8',
                  'annotation.pipeline.claude-version': '2.1.266',
                  'annotation.pipeline.node-version': '22.22.1',
                  'annotation.pipeline.image-policy':
                    '2026-09-10.webdeps-cache2',
                },
              },
            },
          ],
    ),
  );
  process.exit(0);
}
if (name === 'gh') {
  console.log(
    a[0] === 'repo'
      ? JSON.stringify({
          nameWithOwner: 'fixture/repo',
          url: 'https://github.com/fixture/repo',
          isPrivate: false,
          viewerPermission: 'READ',
          defaultBranchRef: { name: 'main' },
        })
      : a.includes('user')
        ? 'fixture-user'
        : JSON.stringify({
            sha,
            html_url: 'https://github.com/fixture/repo/commit/' + sha,
          }),
  );
  process.exit(0);
}
if (name === 'git') {
  console.log(
    a[0] === 'rev-parse'
      ? sha
      : a[0] === 'remote'
        ? 'https://github.com/fixture/repo.git'
        : a[0] === 'for-each-ref'
          ? 'refs/remotes/origin/main'
          : '',
  );
  process.exit(0);
}
if (name === 'claude') throw Error('Host Claude must never execute');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  if (a.includes('--model') || a.includes('-m'))
    throw Error('Model override forbidden');
  const schema = a[a.indexOf('--output-schema') + 1],
    out = a[a.indexOf('--output-last-message') + 1],
    stage = [
      'generate',
      'prepare',
      'policy',
      'snapshot',
      'scaffold',
      'score',
      'delivery',
      'next',
      'project-next',
      'runtime-plan',
      'runtime-diagnose',
    ].find((s) => schema.endsWith('.' + s + '.schema.json'));
  fs.appendFileSync(
    process.env.FIXTURE_LOG,
    JSON.stringify({
      name: stage,
      time: Date.now(),
      schemaKeys: Object.keys(JSON.parse(fs.readFileSync(schema)).properties),
    }) + '\n',
  );
  for (const x of ['score', 'project-next', 'delivery']) {
    const flag = path.join(dir, 'fail-' + x + '-once');
    if (stage === x && fs.existsSync(flag)) {
      fs.unlinkSync(flag);
      process.exit(1);
    }
  }
  if (process.env.FIXTURE_DELAY_STAGE === stage)
    await new Promise((resolve) => setTimeout(resolve, 1500));
  const count = fs.existsSync('.fixture-count')
      ? Number(fs.readFileSync('.fixture-count', 'utf8'))
      : 0,
    cats = [
      ...Array.from({ length: 7 }, (_, i) => [
        '0-1 代码生成',
        ...Array(i < 3 ? 2 : 1).fill('Bug 修复'),
        'Feature 迭代',
      ]).flat(),
      '代码理解',
      '代码重构',
      ...Array.from({ length: 3 }, () => [
        '0-1 代码生成',
        'Feature 迭代',
      ]).flat(),
    ];
  const allocatedCategory =
    JSON.parse(fs.readFileSync(schema, 'utf8')).properties.category
      ?.enum?.[0] ||
    input.match(/本题已分配分类：([^，\n]+)/)?.[1] ||
    '代码测试';
  const values = {
    'runtime-plan': {
      summary: 'synthetic independent runtime plan',
      checks: [
        {
          id: 'check',
          kind: 'acceptance',
          command:
            !process.env.FIXTURE_STOP_PROJECT && cats[count] === 'Bug 修复'
              ? '__runtime_bug__'
              : '__runtime_pass__',
          expected: '4',
          requirement: 'synthetic existing requirement',
          codeEvidence: '.fixture-count:1',
          timeoutSeconds: 5,
        },
        {
          id: 'current_acceptance',
          kind: 'acceptance',
          command: '__runtime_pass__',
          expected: '4',
          requirement: 'current question acceptance',
          codeEvidence: '.fixture-count:1',
          timeoutSeconds: 5,
        },
      ],
    },
    'runtime-diagnose': {
      summary: 'synthetic independent runtime diagnosis',
      checks: [
        {
          id: 'check',
          outcome:
            !process.env.FIXTURE_STOP_PROJECT && cats[count] === 'Bug 修复'
              ? 'reproduced'
              : 'passed',
          observed: 'synthetic runtime result',
          evidenceLine: 1,
        },
        {
          id: 'current_acceptance',
          outcome: 'passed',
          observed: 'current question independently passed',
          evidenceLine: 1,
        },
      ],
    },
    scaffold: {
      templateId: 'custom',
      readiness: {
        startCommand: 'node src/index.js',
        port: 8080,
        smokeCommand: 'node --check src/index.js',
      },
      stack: 'fixture',
      summary: '用于测试的最小项目骨架',
      startup: 'node src/index.js',
      files: [
        { path: 'src/index.js', content: 'export {};\n', executable: false },
      ],
    },
    generate: {
      title: '__DOCKER_AUTO__' + Date.now(),
      prompt: question('Synthetic independent project'),
      category: '0-1 代码生成',
      difficulty: '中等',
      stack: 'fixture',
    },
    prepare: {
      prompt: categoryQuestion(allocatedCategory, count),
      category: allocatedCategory,
      difficulty: '中等',
      stack: 'fixture',
      acceptance: ['fixture evidence'],
    },
    policy: {
      ...questionAudit,
      simpleFeatures: [],
      difficultyEvidence: ['scope', 'context', 'interaction', 'breadth'],
      assessedDifficulty: '中等',
      followupFix: false,
      followupReason: '首轮或非产物修复',
      allowed: !input.includes('用户原目标：__POLICY_REJECT__'),
      matchedRuleIds: input.includes('用户原目标：__POLICY_REJECT__')
        ? ['games']
        : [],
      duplicateTaskIds: [],
      checkedGroups: ['games', 'desktop', 'business', 'dashboard'],
      reason: 'synthetic policy evidence',
    },
    snapshot: {
      ready: true,
      head: 'sha256:' + 'a'.repeat(64),
      remote: 'adminfather/benzhi-claude-code',
      environmentLevel: '无外部依赖',
      dependencies: [],
      startup: 'fixture',
      verification: 'fixture',
      notes: ['fixture'],
    },
    score: {
      when: Array(5).fill('fixture step'),
      behavior: Array(5).fill('fixture behavior'),
      impact: Array(5).fill('fixture impact'),
      expected: Array(5).fill('fixture expected'),
      evidenceRefs: Array(5).fill(
        (input.match(/本轮轨迹文件：([^\n]+)/) || [])[1] + ':1',
      ),
      processFindings: 'fixture',
      artifactFindings: 'fixture',
      scores: [3, 3, 3, 3, 3],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
      other: '无',
    },
    delivery: {
      passed: true,
      checks: ['fixture'],
      summary: 'synthetic verified',
    },
    next: {
      action: 'complete',
      prompt: '无',
      reason: 'fixture complete',
      repairCheckIds: [],
    },
    'project-next': {
      repairCheckIds:
        !process.env.FIXTURE_STOP_PROJECT && cats[count] === 'Bug 修复'
          ? ['check']
          : [],
      action:
        process.env.FIXTURE_STOP_PROJECT || !cats[count]
          ? 'complete'
          : cats[count] === 'Bug 修复'
            ? 'repair'
            : 'advance',
      prompt:
        process.env.FIXTURE_STOP_PROJECT || !cats[count]
          ? '无'
          : categoryQuestion(cats[count], count + 1),
      category: cats[count] || 'Feature 迭代',
      difficulty: '中等',
      reason: 'synthetic file evidence',
      baseComplete:
        !!process.env.FIXTURE_STOP_PROJECT || cats[count] !== 'Bug 修复',
      projectEvidence: 'project engine.ts exists',
    },
  };
  if (process.env.FIXTURE_REJECT_WORDING_ONCE) {
    const rejected = path.join(dir, 'wording-rejected');
    if (stage === 'prepare' && !fs.existsSync(rejected))
      values.prepare.prompt += '处理结果可以回看和比较。';
    if (
      stage === 'prepare' &&
      fs.existsSync(rejected) &&
      process.env.FIXTURE_DRIFT_WORDING_ACCEPTANCE
    )
      values.prepare.acceptance = [
        'wording must not replace the frozen acceptance',
      ];
    if (stage === 'policy' && !fs.existsSync(rejected)) {
      Object.assign(values.policy, {
        allowed: false,
        questionCompliant: false,
        wordingDuplicatePairs: ['方便回看和比较与处理结果可以回看和比较重复'],
        reason: '候选结尾重复已有结果，需合并后重新审核',
      });
      fs.writeFileSync(rejected, '1');
    }
  }
  const promptOnly =
    stage === 'prepare' &&
    JSON.stringify(
      Object.keys(JSON.parse(fs.readFileSync(schema)).properties),
    ) === '["prompt"]';
  const response = promptOnly
    ? { prompt: values.prepare.prompt }
    : values[stage];
  fs.writeFileSync(out, JSON.stringify(response));
  console.log(
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture-' + stage }),
  );
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: JSON.stringify(response) },
    }),
  );
  console.log(JSON.stringify({ type: 'turn.completed' }));
});
