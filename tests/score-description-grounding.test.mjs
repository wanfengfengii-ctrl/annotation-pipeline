import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scoreDescriptionGroundingIssues } from '../lib/score-description-grounding.mjs';
import { scoreInstructions } from '../lib/workflow.mjs';
import { codexStage } from '../scripts/codex-stages.mjs';

const rejected = [
  '开始制作字段提示时曾出现必填字段路径重复、类型名称不一致的问题，随后用样例定位并修正。最终的字段建议和草稿规则覆盖了这些边界，独立验收未复现业务缺陷。',
  '执行过程中多次因为草稿差异展示和服务停止命令的问题返工，增加了验证时间；这些问题没有遗留在交付中，最终的浏览器与测试记录均为通过。',
];
const grounded = [
  '用样例检查 contracts.py 时，生成的字段提示把客户编号路径拼重复，提示无法对应实际字段；改好路径拼接后重新检查，输出已对应目标字段。',
  '浏览器检查草稿时，页面没有显示新增和改写标记，测试报 AssertionError，补上页面标记后重新检查。收尾用 pkill 停服务返回退出码 144，拆开后续操作才完成验证。',
];
const value = (descriptions) => ({ scores: [4, 3], descriptions });

test('SOLO 2595 vague feedback is reviewed without changing facts or scores', () => {
  const input = value(rejected),
    before = structuredClone(input);
  const issues = scoreDescriptionGroundingIssues(input);
  assert.ok(issues.some((i) => i.includes('第1维') && i.includes('后果')));
  assert.ok(issues.some((i) => i.includes('第2维') && i.includes('定位点')));
  assert.deepEqual(input, before);
  assert.deepEqual(scoreDescriptionGroundingIssues(value(grounded)), []);
});

test('plain observable effects need no line numbers or developer jargon', () => {
  for (const text of [
    '点击完整档案后页面空白，登记无法继续。',
    '保存后列表仍显示旧内容，重新打开详情才能核对修改。',
    '准备示例数据时出现语法错误，数据生成中断；修正后重新生成数据。',
    '页面测试失败，点击预览后页面空白，草稿无法核对。',
    '运行 npm test 后发现标签没有匹配上，补改选择方式后重新运行检查。',
  ])
    assert.deepEqual(scoreDescriptionGroundingIssues(value([text])), [], text);
  assert.ok(
    scoreDescriptionGroundingIssues(
      value([
        '制作字段提示时出现路径重复的问题。若未修正会造成页面无法使用。最终验证通过。',
      ]),
    ).length,
    'hypothetical or final-success clauses do not supply an observed impact',
  );
  assert.match(scoreInstructions(), /最终通过不能代替当时的客观后果/);
  assert.match(scoreInstructions(), /评分时解决，不推迟到上传前/);
});

test('grounding uses the existing single evidence review and blocks unresolved prose', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-grounding-'));
  const oldPath = process.env.PATH;
  const base = {
    scores: [5, 5, 5, 4, 3],
    descriptions: [
      '导入和预览流程均已完成。',
      '要求的确认与取消操作已落实。',
      '先检查数据再安排页面与验证。',
      ...grounded,
    ],
    other: '无',
    when: Array(5).fill('检查当前实现时'),
    behavior: Array(5).fill('核对本轮实际操作'),
    impact: Array(5).fill('草稿标记没有显示，修正后重新检查'),
    expected: Array(5).fill('准确显示草稿变化'),
    evidenceRefs: Array(5).fill('app.js:1'),
    processFindings: '依据本轮证据保留评分与修复过程。',
    artifactFindings: '原件中的草稿标记和最终检查结果已核对。',
  };
  try {
    writeFileSync(path.join(dir, 'app.js'), 'const actual = true;\n');
    writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);let input='';
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const out=args[args.indexOf('--output-last-message')+1],review=out.includes('.consistency.');
if(args.includes('--model')||args.includes('-m'))throw Error('Model override');
fs.appendFileSync(path.join(__dirname,'calls'),JSON.stringify({review})+'\\n');
if(review&&!input.includes('客观后果'))throw Error('Missing grounding requirements');
const value=${JSON.stringify(base)};
if(!review||out.includes('still.'))value.descriptions.splice(3,2,...${JSON.stringify(rejected)});
fs.writeFileSync(out,JSON.stringify(value)); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
});`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + path.delimiter + oldPath;
    const run = (turnId) =>
      codexStage({
        stage: 'score',
        turnId,
        prompt: scoreInstructions(),
        cwd: dir,
        dir,
        onChild() {},
      });
    const repaired = await run('repair');
    assert.deepEqual(repaired.value, base);
    assert.deepEqual(repaired.consistencyRevision.originalScores, base.scores);
    assert.equal(
      JSON.parse(readFileSync(path.join(dir, 'repair.score.json')))
        .descriptions[3],
      rejected[0],
    );
    await assert.rejects(run('still'), /评分表达复评仍需核对/);
    assert.equal(
      readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      4,
    );
    assert.equal(
      readFileSync(path.join(dir, 'app.js'), 'utf8'),
      'const actual = true;\n',
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
