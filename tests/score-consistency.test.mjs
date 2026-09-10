import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexStage } from '../scripts/codex-stages.mjs';
import { scoreConsistencyIssues } from '../lib/score-consistency.mjs';
import { scoreInstructions } from '../lib/workflow.mjs';

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
    writeFileSync(
      path.join(dir, 'codex'),
      `#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2);let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 if(args.includes('--model')||args.includes('-m')) throw Error('Model override');
 const out=args[args.indexOf('--output-last-message')+1],mode=fs.readFileSync(${JSON.stringify(path.join(dir, 'mode'))},'utf8'),review=out.includes('.consistency.');
 fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls'))},JSON.stringify({review,input})+'\\n');
 if(review&&!input.includes('重新读取原题、冻结产物及已验真日志'))throw Error('Evidence review missing');
 const scores=[4,5,5,3,3],descriptions=['位置说明仍需修正。','已落实全部原题约束并保留既有入口。','阶段计划随验证推进。','定位过程多次修正。','测试运行有重复。'];
 if(mode!=='good'&&(!review||mode==='still'))descriptions[1]='有错误但不能当作独立约束偏差。';
 if(review&&mode==='lower'){scores[1]=3;descriptions[1]='遗漏原题的单页替换入口，需补齐。';}
 const value={scores,descriptions,other:'无',when:Array(5).fill('本轮开发时'),behavior:Array(5).fill('核对原始记录'),impact:Array(5).fill('按本维证据判断'),expected:Array(5).fill('落实原题'),evidenceRefs:Array(5).fill('app.js:1'),processFindings:'依据原题核对归属；其他维度问题继续保留。',artifactFindings:'位置说明问题仍保留，验收范围以原日志为准。'};
 fs.writeFileSync(out,JSON.stringify(value));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));
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
    await assert.rejects(run('still'), /评分一致性复评仍需核对/);
    assert.equal(
      readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
      7,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
