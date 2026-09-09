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
if (name === 'docker') {
  if (a[0] === 'exec') {
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
              RepoDigests: [
                'adminfather/benzhi-claude-code@sha256:' + 'a'.repeat(64),
              ],
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
process.stdin.on('end', () => {
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
    JSON.stringify({ name: stage, time: Date.now() }) + '\n',
  );
  for (const x of ['score', 'project-next']) {
    const flag = path.join(dir, 'fail-' + x + '-once');
    if (stage === x && fs.existsSync(flag)) {
      fs.unlinkSync(flag);
      process.exit(1);
    }
  }
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
      ],
    },
    scaffold: {
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
      prompt: categoryQuestion(
        JSON.parse(fs.readFileSync(schema, 'utf8')).properties.category
          ?.enum?.[0] || '代码测试',
        count,
      ),
      category:
        JSON.parse(fs.readFileSync(schema, 'utf8')).properties.category
          ?.enum?.[0] || '代码测试',
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
      baseComplete: true,
      projectEvidence: 'project engine.ts exists',
    },
  };
  fs.writeFileSync(out, JSON.stringify(values[stage]));
  console.log(
    JSON.stringify({ type: 'thread.started', thread_id: 'fixture-' + stage }),
  );
});
