import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkWriting,
  proseIssues,
  writingInstructions,
} from '../lib/writing-style.mjs';
import { scoreDescriptionStyleIssues } from '../lib/score-description-context.mjs';
import { scoreInstructions } from '../lib/workflow.mjs';
import { codexStage } from '../scripts/codex-stages.mjs';

const plain = {
  scores: [3, 5, 4, 4, 4],
  descriptions: [
    '保存后列表仍显示旧内容，重新打开详情才能看到修改，核对记录时需要来回切换。',
    '修改范围集中在保存后的列表更新，原有导入和排序操作都保留了。',
    '先检查保存流程，再修改列表更新，最后安排验证；验证范围没有覆盖保存后的列表显示。',
    '检查了保存请求和返回内容，但没有继续核对列表更新，遗漏了旧内容仍留在页面上的问题。',
    '修改后完成了构建检查，页面操作没有验证，实际显示结果仍需检查。',
  ],
  other: '无',
  when: Array(5).fill('本轮保存记录时'),
  behavior: Array(5).fill('根据本轮原件核对保存及列表更新'),
  impact: Array(5).fill('列表显示旧内容，核对需要切换页面'),
  expected: Array(5).fill('保存后同步更新列表'),
  evidenceRefs: Array(5).fill('app.js:1'),
  processFindings: '本维符合3分档，依据 app.js:1 保留与相邻高档的事实差别。',
  artifactFindings: '精确定位在 app.js:1，页面操作未运行，不声称通过。',
};

test('public evaluation labels trigger wording review without altering facts or internal AI provenance', () => {
  const labels = [
    '独立的 AI 浏览器验收确认这些操作符合题目要求。',
    'AI浏览器验证通过。',
    'ＡＩ 网页检查已完成。',
    '人工智能驱动的浏览器检查确认功能可用。',
  ];
  for (const description of labels) {
    const review = {
      ...plain,
      source: 'codex',
      provenance: 'AI / Codex CLI',
      descriptions: [description, ...plain.descriptions.slice(1)],
      artifactFindings: description,
      processFindings: description,
    };
    const original = structuredClone(review);
    const checked = checkWriting('score', review);
    assert.ok(
      checked.issues.some(
        (issue) =>
          issue.startsWith('descriptions[0]') && issue.includes('评测标签'),
      ),
    );
    assert.ok(
      checked.issues.every((issue) => issue.startsWith('descriptions[0]')),
    );
    assert.deepEqual(checked.value, original);
    assert.deepEqual(review, original);
    assert.ok(
      checkWriting('score', { ...plain, other: description }).issues.some(
        (issue) => issue.startsWith('other'),
      ),
    );
    assert.ok(proseIssues(description, { paragraphs: true }).length);
  }
  for (const description of [
    '本次页面检查中，勾选附加页后旧图和画布标记一起更新，取消后原图保持不变。',
    '页面操作尚未验证，现有记录只说明构建通过。',
    '模型只检查了接口响应，页面跳转后的空白没有在交付前发现。',
  ])
    assert.deepEqual(proseIssues(description), []);
  assert.match(
    scoreInstructions(),
    /公开的题目、点评和其他问题不写 AI 浏览器验收/,
  );
  assert.match(writingInstructions('prepare'), /AI 评分来源保留在来源字段/);
});

test('public prose stays understandable while internal citations and business numbers remain intact', () => {
  assert.deepEqual(checkWriting('score', plain).issues, []);
  for (const text of [
    '点击完整档案后页面空白，后续登记无法继续。',
    '准备示例数据时写出了语法错误，数据生成中断；修正后重新生成了数据。',
    '导入表格第145行为空时没有提示，用户找不到遗漏项。',
    '统计页把95条历史记录算成有效免疫，实际只有23个有效组合。',
    '运行 npm test 后发现页面标签没有匹配上，调整选择方式后通过。',
    '评分方案算出总分38、命中24次，结果和逐项计算一致。',
    '修改集中在 src/data.ts，保留原有排序和导入。',
  ])
    assert.deepEqual(scoreDescriptionStyleIssues(text), [], text);
  for (const text of [
    'src/data.ts:145 修改后仍有旧内容。',
    'session.jsonl#L447 记录了检查失败。',
    '原始轨迹第447行说明检查失败。',
    '出现第145行 SyntaxError，数据生成中断。',
    '保存后仍有旧内容，因此评3分。',
    '保存功能符合3分档，未达到下一档。',
  ]) {
    const value = {
      ...plain,
      descriptions: [text, ...plain.descriptions.slice(1)],
    };
    const before = structuredClone(value);
    const result = checkWriting('score', value);
    assert.ok(result.issues.length, text);
    assert.ok(
      result.issues.every((issue) => issue.startsWith('descriptions[0]')),
    );
    assert.deepEqual(
      result.value,
      before,
      'checks must not erase wording or evidence',
    );
    assert.deepEqual(value, before);
  }
});

test('one wording retry simplifies public feedback, preserves scores and evidence, and retains original output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-prose-'));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(path.join(dir, 'app.js'), 'const saved = true;\n');
    writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), args = process.argv.slice(2);
let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  if (args.includes('--model') || args.includes('-m')) throw Error('Model override');
  const out = args[args.indexOf('--output-last-message') + 1];
  const mode = fs.readFileSync(path.join(__dirname, 'mode'), 'utf8');
  const revised = out.includes('.writing.');
  fs.appendFileSync(path.join(__dirname, 'calls'), JSON.stringify({ revised, out }) + '\\n');
  if (out.includes('.consistency.')) throw Error('Style must not trigger rescoring');
  if (revised && !input.includes('点评用具体操作、现象及影响')) throw Error('Missing prose issue');
  const value = ${JSON.stringify(plain)};
  if (mode === 'internal') {
    value.processFindings += '\\n原工具输出："通过"，证据 app.js:1。';
    value.artifactFindings += '\\n验收原文保留，不改成公开点评。';
  }
  if (!['plain', 'internal'].includes(mode) && (!revised || mode === 'still'))
    value.descriptions[0] = '在 app.js:1 保存后列表仍显示旧内容，重新打开详情才能看到修改，核对记录时需要来回切换，因此评3分。';
  if (revised && mode === 'score-change') value.scores[0] = 4;
  if (revised && mode === 'evidence-change') value.evidenceRefs[0] = 'app.js:2';
  fs.writeFileSync(out, JSON.stringify(value));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }));
});`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + path.delimiter + oldPath;
    const run = async (mode) => {
      writeFileSync(path.join(dir, 'mode'), mode);
      return codexStage({
        stage: 'score',
        prompt: scoreInstructions(),
        turnId: mode,
        cwd: dir,
        dir,
        onChild() {},
      });
    };
    const accepted = await run('plain');
    assert.deepEqual(accepted.value, plain);
    assert.equal(accepted.writingRevision, undefined);
    const internal = await run('internal');
    assert.equal(internal.writingRevision, undefined);
    assert.equal(internal.consistencyRevision, undefined);
    assert.equal(
      internal.value.processFindings,
      plain.processFindings + '\n原工具输出："通过"，证据 app.js:1。',
    );
    assert.equal(
      internal.value.artifactFindings,
      plain.artifactFindings + '\n验收原文保留，不改成公开点评。',
    );
    const revised = await run('revise');
    assert.deepEqual(revised.value, plain);
    assert.equal(revised.consistencyRevision, undefined);
    assert.match(
      revised.writingRevision.originalTracePath,
      /revise.score.events.jsonl$/,
    );
    const original = JSON.parse(
      readFileSync(path.join(dir, 'revise.score.json'), 'utf8'),
    );
    assert.match(original.descriptions[0], /app.js:1.*因此评3分/);
    assert.deepEqual(original.scores, revised.value.scores);
    assert.deepEqual(original.evidenceRefs, revised.value.evidenceRefs);
    await assert.rejects(run('score-change'), /不得改动 score.scores/);
    await assert.rejects(run('evidence-change'), /不得改动 score.evidenceRefs/);
    await assert.rejects(run('still'), /表达修订后仍不符合要求/);
    assert.equal(
      readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      10,
    );
    assert.equal(
      readFileSync(path.join(dir, 'app.js'), 'utf8'),
      'const saved = true;\n',
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
