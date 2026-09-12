import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexStage } from '../scripts/codex-stages.mjs';
import { scoreConsistencyIssues } from '../lib/score-consistency.mjs';
import { scoreInstructions } from '../lib/workflow.mjs';
import { repairScoreClarity } from '../scripts/score-clarity-repair.mjs';

test('SOLO 618 phrasing triggers scoring review without altering the score or erasing evidence', () => {
  const value = {
    scores: [4, 5, 5, 3, 3],
    descriptions: [
      '位置提示错误仍影响校样。',
      '当前位置显示错误属于实现缺陷，不能直接当作违背指令；未见独立约束偏差。',
      '计划按阶段更新。',
      '定位过程多次修正。',
      '测试执行有重复。',
    ],
  };
  const before = structuredClone(value);
  assert.deepEqual(
    scoreConsistencyIssues(value.scores, value.descriptions).map((i) => ({
      index: i.index,
      signals: i.signals,
    })),
    [{ index: 1, signals: ['错误', '不能', '偏差'] }],
  );
  assert.deepEqual(value, before);
  assert.equal(scoreConsistencyIssues([4], ['错误仍未处理。']).length, 0);
  assert.match(scoreInstructions(), /须逐条对照原题约束/);
  assert.match(
    scoreInstructions(),
    /不能通过删词、同义替换、隐藏缺陷或随意调分/,
  );
});

test('scoring performs at most one evidence review, permits evidence-based rescoring and keeps original attempts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'score-consistency-'));
  const oldPath = process.env.PATH;
  try {
    writeFileSync(path.join(dir, 'app.js'), 'const actualEvidence = true;\n\n');
    writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 if(args.includes('--model')||args.includes('-m')) throw Error('Model override');
 const out=args[args.indexOf('--output-last-message')+1],mode=fs.readFileSync(${JSON.stringify(path.join(dir, 'mode'))},'utf8'),review=out.includes('.consistency.');
 fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))},JSON.stringify({review,input})+'\\n');
 if(review&&!input.includes('重新读取原题、冻结产物及已验真日志'))throw Error('Evidence review missing');
 const scores=[4,5,5,3,3],descriptions=['位置说明仍需修正。','已落实全部原题约束并保留既有入口。','阶段计划随验证推进。','定位过程多次修正。','测试运行有重复。'];
 if(!['good','citation'].includes(mode)&&(!review||mode==='still'))descriptions[1]='有错误但不能当作独立约束偏差。';
 if(mode==='clarity'&&review&&!out.includes('.clarity.'))descriptions[1]='重跑不能证明草稿来源仍有效，确认时分别核对运行结果与来源。';
 if(review&&mode==='lower'){scores[1]=3;descriptions[1]='遗漏原题的单页替换入口，需补齐。';}
 const value={scores,descriptions,other:'无',when:Array(5).fill('本轮开发时'),behavior:Array(5).fill('核对原始记录'),impact:Array(5).fill('按本维证据判断'),expected:Array(5).fill('落实原题'),evidenceRefs:Array(5).fill(mode==='citation'&&!review?'app.js:2':'app.js:1'),processFindings:'依据原题核对归属；其他维度问题继续保留。',artifactFindings:'位置说明问题仍保留，验收范围以原日志为准。'};
 const contract=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 const payload=contract.properties.patches?{patches:contract.properties.patches.items.properties.field.enum.map(field=>({field,value:field==='other'?value.other:value[field.split('[')[0]][Number(field.match(/[0-4]/)[0])]}))}:value;
 if(contract.properties.patches&&require('path').basename(out).startsWith('mutation.'))payload.scores=value.scores;
 fs.writeFileSync(out,JSON.stringify(payload));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
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
    const originalGood = await run('good');
    assert.equal(originalGood.consistencyRevision, undefined);
    const cited = await run('citation');
    assert.match(cited.consistencyRevision.issues.join(' '), /空行/);
    assert.equal(cited.value.evidenceRefs[0], 'app.js:1');
    assert.equal(
      readFileSync(path.join(dir, 'app.js'), 'utf8'),
      'const actualEvidence = true;\n\n',
    );
    const clarified = await run('clarify');
    assert.equal(clarified.value.scores[1], 5);
    assert.match(
      clarified.tracePath,
      /clarify\.consistency\.score\.events\.jsonl$/,
    );
    assert.match(
      clarified.consistencyRevision.originalTracePaths[0],
      /clarify\.score\.events\.jsonl$/,
    );
    assert.match(
      JSON.parse(readFileSync(path.join(dir, 'clarify.score.json')))
        .descriptions[1],
      /错误/,
    );
    assert.equal(clarified.value.descriptions[0], '位置说明仍需修正。');
    const rescored = await run('lower');
    assert.equal(rescored.value.scores[1], 3);
    assert.equal(rescored.consistencyRevision.originalScores[1], 5);
    const clarifiedRestriction = await run('clarity');
    assert.equal(clarifiedRestriction.value.scores[1], 5);
    assert.match(
      clarifiedRestriction.tracePath,
      /consistency\.clarity\.score\.events\.jsonl$/,
    );
    assert.match(
      clarifiedRestriction.clarityRepair.originalTracePath,
      /consistency\.score\.events\.jsonl$/,
    );
    assert.ok(
      clarifiedRestriction.consistencyRevision.originalTracePaths.includes(
        clarifiedRestriction.clarityRepair.originalTracePath,
      ),
    );
    await assert.rejects(run('still'), /评分一致性复评仍需核对/);
    assert.equal(
      readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      13,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clarity is bounded and preserves scores, evidence, findings and unaffected descriptions', async () => {
  const original = {
    value: {
      scores: [5, 4],
      descriptions: [
        '重跑不能证明草稿来源有效，确认时分别核对。',
        '保存时页面空白，记录未写入。',
      ],
      evidenceRefs: ['app.js:1'],
      processFindings: '已核对来源校验；保存缺陷仍保留。',
      artifactFindings: '来源过期时禁用确认。',
    },
    tracePath: 'review.jsonl',
  };
  for (const change of ['score', 'evidence', 'finding', 'unaffected']) {
    const value = structuredClone(original.value);
    value.descriptions[0] = '重跑更新运行记录，确认还会核对草稿来源。';
    if (change === 'score') value.scores[0] = 4;
    if (change === 'evidence') value.evidenceRefs[0] = 'invented.js:1';
    if (change === 'finding') value.artifactFindings = '全部正常';
    if (change === 'unaffected') value.descriptions[1] = '保存正常';
    await assert.rejects(
      repairScoreClarity({ turnId: 't', prompt: '' }, original, async () => ({
        value,
      })),
      /不得改动/,
    );
  }
  let calls = 0;
  await assert.rejects(
    repairScoreClarity({ turnId: 't', prompt: '' }, original, async () => {
      calls++;
      return structuredClone(original);
    }),
    /评分一致性复评仍需核对/,
  );
  assert.equal(calls, 1);
  assert.equal(original.value.scores[0], 5);
  assert.match(original.value.descriptions[0], /不能/);
});
