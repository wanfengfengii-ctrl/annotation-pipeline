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
import { formatQuestionText } from '../lib/question-text.mjs';

test('所有出题阶段去掉反引号及空白行，其他字段和已发送原题保持', () => {
  for (const category of [
    '0-1 代码生成',
    'Feature 迭代',
    'Bug 修复',
    '代码理解',
    '代码重构',
  ]) {
    const prompt = fixture
      .categoryQuestion(category)
      .replace(/\n/g, '\r\n\r\n')
      .replace('。', '。`');
    for (const stage of ['generate', 'prepare', 'next', 'project-next']) {
      const value = {
        prompt,
        category,
        action: category === 'Bug 修复' ? 'repair' : 'advance',
        reason: '继续完善原有功能',
        acceptance: ['原验收内容'],
      };
      const result = checkWriting(stage, value);
      assert.deepEqual(result.issues, [], category + ':' + stage);
      assert.equal(result.value.prompt, formatQuestionText(prompt));
      assert.ok(!/[`\r]|\n\s*\n/.test(result.value.prompt));
      assert.equal(value.prompt, prompt);
      assert.deepEqual(result.value.acceptance, value.acceptance);
    }
  }
});
import {
  questionCacheState,
  upgradeQuestionCache,
  legacyRepairContext,
} from '../lib/question-cache.mjs';
import { policyInstructions } from '../lib/task-policy.mjs';
import { runtimeVersion } from '../lib/runtime-verification.mjs';
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
test('口语规则升级重生成未发题和后续草稿，保留已发原文、评分和轨迹', () => {
  const old = {
    questionRuleVersion: '2026-09-09.questions2',
    prepare: { value: { prompt: 'Webhook 可靠投递服务\n历史修复原文' } },
    next: { value: { prompt: '旧规则的下一题草稿' } },
    score: { value: { scores: [3, 4, 4, 3, 3] } },
    policy: { questionRuleVersion: '2026-09-09.questions2' },
  };
  const sent = structuredClone(old);
  const state = questionCacheState(sent, { turnId: 'repair' }, 'repair');
  assert.equal(state.questionStyleApplies, false);
  upgradeQuestionCache(sent, state);
  assert.deepEqual(sent.prepare, old.prepare);
  assert.deepEqual(sent.score, old.score);
  assert.equal(sent.next, undefined);
  assert.equal(sent.questionRuleVersion, questionRules.version);
  assert.equal(
    questionCacheState(sent, { turnId: 'repair' }, 'repair')
      .questionStyleApplies,
    false,
  );
  const draft = structuredClone(old);
  upgradeQuestionCache(draft, questionCacheState(draft, null, 'repair'));
  assert.equal(draft.prepare, undefined);
  assert.equal(draft.next, undefined);
  draft.prepare = { value: { prompt: fixture.repair() } };
  draft.next = { value: { prompt: fixture.repair(2) } };
  const current = structuredClone(draft);
  upgradeQuestionCache(draft, { preserveQuestion: false });
  assert.deepEqual(draft, current);
});

test('仅已执行历史题的同会话真实修复继承界面范围，新题及未复现问题不能豁免', () => {
  const root = {
    id: 'root',
    questionRootId: 'root',
    status: 'review',
    promptId: 'prompt',
    sessionId: 'session',
    prompt: '旧后端服务',
    automation: {
      policy: {
        engine: 'codex-cli',
        accepted: true,
        value: { questionCompliant: false },
      },
      runtimeVerification: {
        version: runtimeVersion,
        executed: true,
        status: 'bugs',
        reportPath: '/report',
        reportSha256: 'hash',
        checks: [
          {
            kind: 'reproduction',
            outcome: 'reproduced',
            exitCode: 1,
            logPath: '/log',
            logSha256: 'hash',
            requirement: '原题要求',
            codeEvidence: 'app.py:1',
          },
        ],
      },
    },
  };
  const repair = {
    id: 'repair',
    category: 'Bug 修复',
    repairOf: 'root',
    questionRootId: 'root',
  };
  const task = { turns: [root, repair] };
  assert.deepEqual(legacyRepairContext(task, repair), {
    rootId: 'root',
    previousTurnId: 'root',
    originalPrompt: '旧后端服务',
  });
  for (const category of [
    '0-1 代码生成',
    'Feature 迭代',
    '代码理解',
    '代码重构',
  ])
    assert.equal(legacyRepairContext(task, { ...repair, category }), null);
  for (const change of [
    (r) => {
      delete r.promptId;
    },
    (r) => {
      delete r.sessionId;
    },
    (r) => {
      r.excluded = true;
    },
    (r) => {
      r.automation.policy.accepted = false;
    },
    (r) => {
      r.automation.policy.questionRuleVersion = '2026-09-09.questions1';
    },
    (r) => {
      r.automation.runtimeVerification.status = 'passed';
    },
    (r) => {
      r.automation.runtimeVerification.checks[0].exitCode = 0;
    },
  ]) {
    const copy = structuredClone(task);
    change(copy.turns[0]);
    assert.equal(legacyRepairContext(copy, repair), null);
  }
  assert.equal(
    legacyRepairContext(task, { ...repair, questionRootId: 'other' }),
    null,
  );
  assert(!writingInstructions('prepare').includes('本轮范围继承说明'));
  const scoped = writingInstructions('prepare', { legacyRepair: true });
  assert.match(scoped, /本轮范围继承说明/);
  assert.match(scoped, /不适用于首题、0-1、Feature、理解或重构/);
  const policy = policyInstructions({ legacyRepair: true });
  for (const required of [
    '固定禁出规则',
    '固定难度规则',
    'questionCompliant',
  ]) {
    assert(policy.includes(required));
  }
  for (const category of ['[games]', '[desktop]', '[business]', '[dashboard]'])
    assert(policy.includes(category));
});

test('0-1 题目使用无编号的项目名称和自然正文，点评保留独立格式', () => {
  const prompt = fixture.question();
  const checked = checkWriting('prepare', {
    prompt: '“' + prompt + '”',
    acceptance: ['原值'],
  });
  assert.deepEqual(checked.issues, []);
  assert.equal(checked.value.prompt, formatQuestionText(prompt));
  assert.deepEqual(checked.value.acceptance, ['原值']);
  assert.equal(questionParts(prompt).paragraphs.length, 2);
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

test('0-1 新题检查项目名称、段落、语气和编排信息', () => {
  for (const stage of ['generate', 'prepare', 'next', 'project-next']) {
    assert.deepEqual(
      checkWriting(stage, {
        prompt: fixture.question('投递结果对照工作台'),
        action: 'advance',
        category: '0-1 代码生成',
        reason: '现有结果与预期不一致',
      }).issues,
      [],
    );
    for (const prompt of [
      '1、' + fixture.question(),
      '第十二题 ' + fixture.question(),
      '只有一个概念',
      fixture.question().replace('网页工作台', '网页工作台，可能需要'),
      fixture.question().replace('网页工作台', '网页工作台，竟然'),
      fixture.question().replace('网页工作台', '网页工作台“联调”'),
      fixture.question().replace('为需要', '技术栈：为需要'),
      fixture.question() + '，仅在 /workspace 创建代码。',
    ])
      assert.ok(
        checkWriting(stage, {
          prompt,
          action: 'advance',
          category: '0-1 代码生成',
          reason: '现有结果与预期不一致',
        }).issues.length,
        stage + ': ' + prompt,
      );
    assert.match(
      writingInstructions(stage),
      /不设字数、段落数、关联操作数或业务细节数门槛/,
    );
    assert.match(writingInstructions(stage), /Feature/);
  }
  for (const n of [1, 180, 260, 268, 1000])
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

test('所有题型自然分段不受两段上限限制，空正文仍不通过', () => {
  for (const category of [
    '0-1 代码生成',
    'Feature 迭代',
    'Bug 修复',
    '代码理解',
    '代码重构',
  ]) {
    const body =
      '打开网页查看保存的记录。\n选择一条记录后显示内容。\n修改名称后保存，返回列表能看到新名称。\n输入为空时说明原因并保留原记录。';
    const prompt = category === '0-1 代码生成' ? '记录整理页\n' + body : body;
    for (const stage of ['generate', 'prepare', 'next', 'project-next']) {
      const result = checkWriting(stage, {
        category,
        prompt,
        action: category === 'Bug 修复' ? 'repair' : 'advance',
        reason: '更新已有记录的名称',
      });
      assert.deepEqual(result.issues, [], category + ':' + stage);
      assert.equal(result.value.prompt, prompt);
    }
    assert.ok(
      questionIssues(category === '0-1 代码生成' ? '只有名称' : '', {
        category,
      }).length,
    );
  }
});

test('除 0-1 外所有类型只接受正文，第一段参与段落与语气检查', () => {
  for (const category of [
    'Feature 迭代',
    'Bug 修复',
    '代码理解',
    '代码重构',
    '工程化',
    '代码测试',
  ]) {
    const prompt = fixture.categoryQuestion(category);
    const parts = questionParts(prompt, { category });
    assert.equal(parts.title, '', category);
    assert.equal(parts.paragraphs.length, 2, category);
    assert.equal(
      parts.bodyLength,
      [...prompt.replace(/\s/g, '')].length,
      category,
    );
    for (const stage of ['prepare', 'project-next']) {
      const value = {
        prompt,
        category,
        action: category === 'Bug 修复' ? 'repair' : 'advance',
        reason: '本轮已有明确目标',
      };
      assert.deepEqual(checkWriting(stage, value).issues, [], category);
      for (const invalid of [
        '项目名称\n' + prompt,
        '项目名称\n' + prompt.replace(/\n+/g, ''),
        '可能需要' + prompt,
        '1、' + prompt,
      ])
        assert.ok(
          checkWriting(stage, { ...value, prompt: invalid }).issues.length,
          category + ': ' + invalid,
        );
    }
    const policy = policyInstructions({ category });
    assert.match(
      policy,
      category === 'Bug 修复'
        ? /language：Bug 修复没有项目名称或标题/
        : /language：本题没有项目名称、标题或编号/,
    );
  }
  assert.ok(
    questionIssues(fixture.body, { category: '0-1 代码生成' }).length,
    '0-1 仍然需要标题',
  );
});

test('Bug 准备和追问直接用口语正文，拒绝项目标题和正式措辞', () => {
  const prompt = fixture.repair();
  for (const stage of ['prepare', 'next', 'project-next']) {
    const context =
      stage === 'prepare' ? { category: 'Bug 修复' } : { action: 'repair' };
    assert.deepEqual(
      checkWriting(stage, { ...context, prompt, reason: '已有问题需要修复' })
        .issues,
      [],
      stage,
    );
    for (const bad of [
      'Webhook 可靠投递服务\n' + prompt,
      'Webhook 可靠投递服务\n' + prompt.replace(/\n+/g, ''),
      prompt.replace('把这里改好', '请落实修复并核验既有重试语义'),
      prompt.replace('现在', '面向维护服务的开发者，现在'),
      prompt.replace('现在', '现在可能'),
      prompt.replace('现在', '现在竟然'),
      prompt.replace('现在', '现在“事件”'),
    ])
      assert.ok(
        checkWriting(stage, {
          ...context,
          prompt: bad,
          reason: '已有问题需要修复',
        }).issues.length,
        stage + ': ' + bad,
      );
  }
  const parts = questionParts(prompt, { category: 'Bug 修复' });
  assert.equal(parts.title, '');
  assert.equal(parts.paragraphs.length, 2);
  assert.match(parts.body, /^现在事件/);
  assert.match(
    policyInstructions({ category: 'Bug 修复' }),
    /audience：沿用原题的实际使用场景/,
  );
  assert.match(
    policyInstructions({ category: 'Bug 修复' }),
    /language：Bug 修复没有项目名称或标题/,
  );
});

test('业务内容审核不以操作或细节数量拦截，仍检查证据结构和否决结果', () => {
  assert.doesNotThrow(() => assertQuestionAudit(fixture.questionAudit));
  for (const count of [0, 1, 3, 7, 12]) {
    const evidence = Array.from(
      { length: count },
      (_, i) => `正文依据${i + 1}`,
    );
    assert.doesNotThrow(() =>
      assertQuestionAudit({
        ...fixture.questionAudit,
        workflowFeatures: evidence,
        businessDetails: evidence,
      }),
    );
  }
  for (const value of [
    { ...fixture.questionAudit, questionCompliant: false },
    { ...fixture.questionAudit, questionChecks: [] },
    {
      ...fixture.questionAudit,
      questionChecks: Array(Object.keys(questionRules.criteria).length).fill(
        'audience：重复',
      ),
    },
    { ...fixture.questionAudit, workflowFeatures: null },
    { ...fixture.questionAudit, workflowFeatures: [''] },
    { ...fixture.questionAudit, workflowFeatures: ['重复', ' 重复 '] },
    { ...fixture.questionAudit, businessDetails: '无' },
    { ...fixture.questionAudit, businessDetails: [12] },
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
  assert.match(draft.issues[0], /descriptions\[0\].*命中词：可能/);
  const negated = '没有反复猜测，日志记录了输入校验和重试结果。';
  assert.match(proseIssues(negated)[0], /命中词：猜测/);
  assert.equal(
    checkWriting('score', {
      descriptions: Array(5).fill(negated),
      other: '无',
      processFindings: '未验证',
      artifactFindings: '缺少记录',
    }).value.descriptions[0],
    negated,
  );
  assert.match(
    proseIssues('可能没有反复猜测，也可能未执行。')[0],
    /命中词：可能、猜测，/,
  );
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
  if(revised && !input.includes('命中词：可能')) throw Error('Missing exact writing issue');
  const mode=fs.existsSync(${JSON.stringify(path.join(dir, 'mode'))})?fs.readFileSync(${JSON.stringify(path.join(dir, 'mode'))},'utf8'):'';
  const value={prompt:revised&&mode!=='invalid'?${JSON.stringify(fixture.categoryQuestion('Feature 迭代'))}:'可能需要加上订单筛选',category:revised&&mode==='changed'?'Bug 修复':'Feature 迭代',difficulty:'中等',stack:'TypeScript',acceptance:['切换状态重置页码','空列表测试']};
  if(revised){
    const contract=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));
    if(JSON.stringify(contract.required)!=='["prompt"]'||contract.additionalProperties!==false) throw Error('Frozen preparation fields exposed to wording model');
  }
  fs.writeFileSync(out,JSON.stringify(revised&&mode!=='changed'?{prompt:value.prompt}:value)); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
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
    assert.equal(
      result.value.prompt,
      formatQuestionText(fixture.categoryQuestion('Feature 迭代')),
    );
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
      /只能返回 prompt 字段/,
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

test('题目内部去重是独立审核项，发现复述即使总判定通过也不能放行', () => {
  assert.ok(questionRules.criteria.redundancy);
  assert.throws(
    () =>
      assertQuestionAudit({
        ...fixture.questionAudit,
        wordingDuplicatePairs: ['按当前页位显示；与当前页位一致：同一预期重复'],
      }),
    /话语重复/,
  );
  const missing = { ...fixture.questionAudit };
  delete missing.wordingRequirements;
  assert.throws(() => assertQuestionAudit(missing), /逐句去重/);
  assert.doesNotThrow(() => assertQuestionAudit(fixture.questionAudit));
});
