import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkWriting,
  proseIssues,
  questionIssues,
  writingInstructions,
} from '../lib/writing-style.mjs';
import { codexStage } from '../scripts/codex-stages.mjs';
import fixture from './fixtures/question.cjs';
import { questionCacheState } from '../lib/question-cache.mjs';
import {
  questionParts,
  assertQuestionAudit,
  questionRules,
} from '../lib/question-writing.mjs';

test('规则升级保留正在终端执行的原题，旧题不追溯套格式，新规则审核不会丢失', () => {
  const cached = { prepare: { value: { prompt: '历史原题' } } };
  assert.deepEqual(questionCacheState(cached, { turnId: 'one' }, 'one'), {
    preserveQuestion: true,
    questionStyleApplies: false,
  });
  assert.equal(cached.prepare.value.prompt, '历史原题');
  assert.deepEqual(questionCacheState(cached, { turnId: 'other' }, 'one'), {
    preserveQuestion: false,
    questionStyleApplies: true,
  });
  const executed = {
    ...cached,
    claude: { success: true },
    policy: { questionRuleVersion: questionRules.version },
  };
  assert.deepEqual(questionCacheState(executed, null, 'one'), {
    preserveQuestion: true,
    questionStyleApplies: true,
  });
  assert.throws(
    () => questionCacheState({}, { turnId: 'one' }, 'one'),
    /不能重新生成或重发/,
  );
});

test('题目使用无编号的项目名称和一至两段正文，不追加项目路径；点评保留独立格式', () => {
  const prompt = fixture.question();
  const checked = checkWriting('prepare', {
    prompt: '“' + prompt + '”',
    acceptance: ['原值'],
  });
  assert.deepEqual(checked.issues, []);
  assert.equal(checked.value.prompt, prompt);
  assert.deepEqual(checked.value.acceptance, ['原值']);
  assert.equal(questionParts(prompt).paragraphs.length, 2);
  assert.ok(questionParts(prompt).bodyLength <= 260);
  assert.ok(!checked.value.prompt.includes('projects/'));
  assert.deepEqual(
    checkWriting('next', {
      action: 'complete',
      prompt: '无',
      reason: '本轮已结束',
    }).issues,
    [],
  );
  assert.match(writingInstructions('score'), /一段/);
});

test('首题、准备、迭代和 Bug 追问统一检查长度、段落、语气和编排信息', () => {
  for (const stage of ['generate', 'prepare', 'next', 'project-next']) {
    assert.deepEqual(
      checkWriting(stage, {
        prompt: fixture.question('投递结果对照工作台'),
        action: 'repair',
        reason: '现有结果与预期不一致',
      }).issues,
      [],
    );
    for (const prompt of [
      '1、' + fixture.question(),
      '第十二题 ' + fixture.question(),
      '只有一个概念',
      '项目\n短需求',
      '项目\n' + '需'.repeat(261),
      fixture.question().replace('网页工作台', '网页工作台，可能需要'),
      fixture.question().replace('网页工作台', '网页工作台，竟然'),
      fixture.question().replace('网页工作台', '网页工作台“联调”'),
      fixture.question() + '\n第三段',
      fixture.question().replace('为需要', '技术栈：为需要'),
      fixture.question() + '，仅在 /workspace 创建代码。',
    ])
      assert.ok(
        checkWriting(stage, {
          prompt,
          action: 'repair',
          reason: '现有结果与预期不一致',
        }).issues.length,
        stage + ': ' + prompt,
      );
    assert.match(writingInstructions(stage), /4 至 6/);
    assert.match(writingInstructions(stage), /Feature/);
  }
  for (const n of [180, 260])
    assert.deepEqual(questionIssues('测试\n' + '需'.repeat(n)), []);
  assert.deepEqual(questionIssues(fixture.question('3D 展示方案对照台')), []);
  assert.ok(
    checkWriting('project-next', {
      action: 'complete',
      prompt: fixture.question(),
      reason: '结束',
    }).issues.length,
  );
  assert.ok(proseIssues(fixture.body).length, '点评仍不允许分段');
});

test('业务内容审核逐项留证，不允许数量不符、缺少依据或否决结果通过', () => {
  assert.doesNotThrow(() => assertQuestionAudit(fixture.questionAudit));
  for (const value of [
    { ...fixture.questionAudit, questionCompliant: false },
    { ...fixture.questionAudit, questionChecks: [] },
    {
      ...fixture.questionAudit,
      questionChecks: Array(Object.keys(questionRules.criteria).length).fill(
        'audience：重复',
      ),
    },
    { ...fixture.questionAudit, workflowFeatures: ['一', '二', '三'] },
    {
      ...fixture.questionAudit,
      workflowFeatures: ['一', '二', '三', '四', '五', '六', '七'],
    },
    { ...fixture.questionAudit, businessDetails: [] },
    { ...fixture.questionAudit, businessDetails: ['重复', '重复'] },
  ])
    assert.throws(() => assertQuestionAudit(value), /题目内容审核/);
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
  const value={prompt:revised&&mode!=='invalid'?${JSON.stringify(fixture.question())}:'可能需要加上订单筛选',category:revised&&mode==='changed'?'Bug 修复':'Feature 迭代',difficulty:'中等',stack:'TypeScript',acceptance:['切换状态重置页码','空列表测试']};
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
    assert.equal(result.value.prompt, fixture.question());
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
