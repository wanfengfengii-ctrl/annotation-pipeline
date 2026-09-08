import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkWriting,
  proseIssues,
  withProjectScope,
  writingInstructions,
} from '../lib/writing-style.mjs';
import { codexStage } from '../scripts/codex-stages.mjs';

test('题目与每项点评允许多个句子的一段话，去外围引号并保留技术字面量', () => {
  const prompt =
    '请加上订单筛选，切换状态时回到第一页。保留 `status="pending"` 的接口格式，并补上空列表测试。';
  const checked = checkWriting('prepare', {
    prompt: '“' + prompt + '”',
    acceptance: ['原值'],
  });
  assert.deepEqual(checked.issues, []);
  assert.equal(checked.value.prompt, prompt);
  assert.deepEqual(checked.value.acceptance, ['原值']);
  const scoped = withProjectScope(prompt, 'projects/p-test');
  assert.deepEqual(proseIssues(scoped), []);
  assert.equal(withProjectScope(scoped, 'projects/p-test'), scoped);
  assert.match(scoped, /status="pending"/);
  assert.match(scoped, /仅在 projects\/p-test 创建或修改/);
  assert.deepEqual(
    checkWriting('next', { prompt: '继续', reason: '本轮输出被截断' }).issues,
    [],
  );
  assert.match(writingInstructions('score'), /一段/);
});

test('拒绝推测和情绪语气，保留未核验的事实边界而不是机械删词', () => {
  for (const text of [
    '可能通过了测试',
    '代码竟然没改',
    '这个实现“完美”',
    '完成了！',
    '触发节点：测试阶段',
    '第一项\n第二项',
  ])
    assert.ok(proseIssues(text).length, text);
  const draft = checkWriting('score', {
    descriptions: Array(5).fill('可能通过了测试'),
    other: '无',
    processFindings: '未验证',
    artifactFindings: '缺少记录',
  });
  assert.equal(draft.value.descriptions[0], '可能通过了测试');
  assert.ok(draft.issues.length);
  assert.deepEqual(
    proseIssues('已改好筛选逻辑，轨迹中没有测试记录，测试结果未验证。'),
    [],
  );
  assert.deepEqual(
    proseIssues('请保留提示文案 `"可能失败！"`，并校验失败分支。'),
    [],
  );
  assert.deepEqual(
    proseIssues('评估调度死锁的可能性，并给出可复现的输入。'),
    [],
  );
});

test('Codex 自动修订一次表达，保持配置模型和结构化结论，失败不会无限重试', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'writing-stage-'));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs'); const args=process.argv.slice(2); let input='';
process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
  if(args.includes('--model')||args.includes('-m')) throw Error('Unexpected model override');
  if(!input.includes('一段完整、连贯的口语化文字')) throw Error('Missing writing policy');
  const out=args[args.indexOf('--output-last-message')+1];
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))}, 'call\\n');
  const revised=out.includes('.writing.');
  const mode=fs.existsSync(${JSON.stringify(path.join(dir, 'mode'))})?fs.readFileSync(${JSON.stringify(path.join(dir, 'mode'))},'utf8'):'';
  const value={prompt:revised&&mode!=='invalid'?'加上订单筛选。切换状态时重置页码，并补上空列表测试。':'可能需要加上订单筛选',category:revised&&mode==='changed'?'Bug 修复':'Feature 迭代',difficulty:'中等',stack:'TypeScript',acceptance:['切换状态重置页码','空列表测试']};
  fs.writeFileSync(out,JSON.stringify(value)); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
});`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + path.delimiter + oldPath;
    const options = {
      stage: 'prepare',
      prompt: 'fixture',
      cwd: dir,
      dir,
      onChild() {},
    };
    const result = await codexStage({ ...options, turnId: 'good' });
    assert.match(result.value.prompt, /切换状态时重置页码/);
    assert.deepEqual(result.value.acceptance, [
      '切换状态重置页码',
      '空列表测试',
    ]);
    assert.match(
      result.writingRevision.originalTracePath,
      /good.prepare.events.jsonl$/,
    );
    writeFileSync(path.join(dir, 'mode'), 'changed');
    await assert.rejects(
      codexStage({ ...options, turnId: 'changed' }),
      /不得改动 prepare.category/,
    );
    writeFileSync(path.join(dir, 'mode'), 'invalid');
    await assert.rejects(
      codexStage({ ...options, turnId: 'invalid' }),
      /表达修订后仍不符合要求/,
    );
    assert.equal(
      readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      6,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
