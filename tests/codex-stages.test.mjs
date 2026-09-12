import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateStage,
  validateAllocation,
  applyPreparationWording,
  codexStage,
} from '../scripts/codex-stages.mjs';
import { issues, csv } from '../lib/pipeline.ts';
test('score checks inconsistent facts before wording and does not rerun acceptance', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-facts-first-')),
    bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(dir, 'app.js'), 'export const checked = true;\n');
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const base = {
    scores: [5, 5, 5, 5, 5],
    descriptions: [
      '填写登记内容后能保存，刷新页面后仍能看到刚才的记录。',
      '表单提供了原题要求的登记项，必填内容未填时会提示补充。',
      '先检查已有页面和保存方式，再补齐登记操作，收尾核对保存结果。',
      '根据保存后的返回内容确认记录状态，判断与页面显示一致。',
      '修改后检查了输入和保存过程，页面能显示提交的内容。',
    ],
    other: '无',
    when: Array(5).fill('本轮完成时'),
    behavior: Array(5).fill('核对登记操作'),
    impact: Array(5).fill('记录正常保存'),
    expected: Array(5).fill('可查看保存的记录'),
    evidenceRefs: Array(5).fill('app.js:1'),
    processFindings: '按本轮实际记录核对',
    artifactFindings: '源码保留登记操作',
  };
  writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(base));
  writeFileSync(
    path.join(bin, 'codex'),
    `#!${process.execPath}\nconst fs=require('fs'),path=require('path');const args=process.argv.slice(2),file=args[args.indexOf('--output-last-message')+1];const label=path.basename(file);fs.appendFileSync('calls.log',label+'\\n');if(label.includes('.writing.'))process.exit(23);const v=JSON.parse(fs.readFileSync('fixture.json'));if(!label.includes('.consistency.'))v.descriptions[0]='AI 浏览器发现错误，保存登记内容后页面为空。';fs.writeFileSync(file,JSON.stringify(v));console.log(JSON.stringify({type:'thread.started',thread_id:'score-fixture'}));`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + previousPath;
  const result = await codexStage({
    stage: 'score',
    prompt: '只读核对本轮记录',
    cwd: dir,
    dir,
    turnId: 'fixture',
    onChild: () => {},
  });
  assert.deepEqual(result.value.scores, base.scores);
  assert.equal(result.value.descriptions[0], base.descriptions[0]);
  assert.deepEqual(
    readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n'),
    ['fixture.score.json', 'fixture.consistency.score.json'],
  );
  assert.equal(
    readFileSync(path.join(dir, 'app.js'), 'utf8'),
    'export const checked = true;\n',
  );
});
test('the budget-only CLI contract returns a preserved full plan without requesting business text again', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-cli-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    path.join(bin, 'codex'),
    `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));if(JSON.stringify(schema.required)!=='["timeouts"]')process.exit(2);const ids=schema.properties.timeouts.items.properties.id.enum;fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({timeouts:ids.map(id=>({id,timeoutSeconds:200}))}));console.log(JSON.stringify({type:'thread.started',thread_id:'budget-fixture'}));`,
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + previousPath;
  const base = {
    summary: '保持说明',
    checks: Array.from({ length: 4 }, (_, i) => ({
      id: 'check' + i,
      kind: 'acceptance',
      command: 'true',
      requirement: '明确说明无法对照的页面并禁用展开',
      expected: '原业务预期',
      codeEvidence: 'app.js:1',
      timeoutSeconds: 300,
    })),
  };
  const result = await codexStage({
    stage: 'runtime-plan',
    prompt: '只分配原步骤时限',
    cwd: dir,
    dir,
    turnId: 'fixture',
    onChild: () => {},
    runtimeBudgetBase: base,
  });
  assert.deepEqual(result.value, {
    ...base,
    checks: base.checks.map((c) => ({ ...c, timeoutSeconds: 200 })),
  });
  assert.ok(base.checks.every((c) => c.timeoutSeconds === 300));
  const patch = JSON.parse(
    readFileSync(path.join(dir, 'fixture.runtime-plan.json')),
  );
  assert.deepEqual(Object.keys(patch), ['timeouts']);
  assert.equal(result.threadId, 'budget-fixture');
});
test('preparation wording changes only prompt and preserves frozen obligations without mutation', () => {
  const base = {
    prompt: '原题',
    category: '代码理解',
    difficulty: '中等',
    stack: 'JavaScript',
    acceptance: ['说明全部有效目标', '原测试与浏览器验收分开说明'],
  };
  const frozen = structuredClone(base);
  const result = applyPreparationWording(base, { prompt: '通俗的题目正文' });
  assert.deepEqual({ ...result, prompt: base.prompt }, frozen);
  assert.deepEqual(base, frozen);
  result.acceptance.push('不应影响原文');
  assert.deepEqual(base, frozen);
  for (const patch of [
    { prompt: 'x', acceptance: ['删掉验收'] },
    { prompt: 'x', category: 'Bug 修复' },
    { prompt: '' },
    null,
  ])
    assert.throws(
      () => applyPreparationWording(base, patch),
      /只能返回 prompt/,
    );
});
test('Weighted allocation cannot be changed by independent question planning', () => {
  const allocation = { category: 'Feature 迭代' };
  assert.throws(
    () =>
      validateAllocation('prepare', { category: '0-1 代码生成' }, allocation),
    /weighted allocation/,
  );
  assert.throws(
    () =>
      validateAllocation(
        'project-next',
        {
          action: 'advance',
          category: '0-1 代码生成',
        },
        allocation,
      ),
    /weighted allocation/,
  );
  assert.throws(
    () =>
      validateAllocation(
        'project-next',
        {
          action: 'advance',
          category: '代码理解',
        },
        { category: null },
      ),
    /weighted allocation/,
  );
  for (const value of [
    { action: 'advance', category: 'Feature 迭代' },
    { action: 'repair', category: 'Bug 修复' },
    { action: 'complete', category: 'Feature 迭代' },
  ])
    assert.equal(validateAllocation('project-next', value, allocation), value);
});
test('Codex structured stage validation rejects malformed scores', () => {
  assert.throws(() =>
    validateStage('score', {
      scores: [5, 5, 5, 5, 6],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
      other: '无',
    }),
  );
  assert.throws(() =>
    validateStage('score', { scores: [5], descriptions: ['a'], other: '无' }),
  );
  assert.throws(() =>
    validateStage('prepare', {
      prompt: 'x',
      category: 'invented',
      difficulty: '中等',
      stack: 'Go',
      acceptance: ['x'],
    }),
  );
  assert.equal(
    validateStage('delivery', {
      passed: false,
      checks: ['缺少证据'],
      summary: '未通过',
    }).passed,
    false,
  );
});
test('AI ratings require delivery verification and retain provenance in export', () => {
  const review = {
    source: 'codex',
    attested: false,
    reviewer: 'Codex CLI',
    scores: [3, 3, 3, 3, 3],
    descriptions: ['a', 'b', 'c', 'd', 'e'],
    other: '无',
  };
  const r = {
    status: 'review',
    createdAt: new Date().toISOString(),
    prompt: 'goal',
    category: 'Feature 迭代',
    difficulty: '中等',
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/trace',
    review,
  };
  const t = {
    title: 'AI test',
    snapshot: 'https://github.com/a/b/commit/' + 'a'.repeat(40),
    harnessVersion: 'v',
    os: 'macOS',
    turns: [r],
  };
  assert.equal(issues(t, r).length, 1);
  r.automation = {
    delivery: { value: { passed: true } },
    bundlePath: '/bundle',
  };
  assert.deepEqual(issues(t, r), []);
  assert.match(csv([t]), /AI \/ Codex CLI/);
  assert.match(csv([t]), /不作为原项目人工标注/);
  assert.equal(review.attested, false);
});

test('generation wording preserves its generation schema without preparation-only acceptance', () => {
  const base = {
    title: '项目',
    prompt: '原题',
    category: '0-1 代码生成',
    difficulty: '中等',
    stack: 'JavaScript',
  };
  assert.deepEqual(
    applyPreparationWording(base, { prompt: '修订后的题目' }, 'generate'),
    { ...base, prompt: '修订后的题目' },
  );
  assert.throws(
    () =>
      applyPreparationWording(
        base,
        { prompt: 'x', category: 'Bug 修复' },
        'generate',
      ),
    /只能返回 prompt/,
  );
});
