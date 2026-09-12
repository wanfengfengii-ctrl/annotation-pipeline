import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexStage } from '../scripts/codex-stages.mjs';
import { verifyScoreEvidence } from '../scripts/evidence.mjs';
import { sealStage, restoreStage } from '../scripts/stage-checkpoint.mjs';

test('invalid citations get one read-only correction, preserving scores, prose and original review artifacts', async (t) => {
  const dir = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'citation-repair-')),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'questions', 'turn', 'workspace');
  mkdirSync(cwd, { recursive: true });
  const log = path.join(dir, 'runtime.log');
  writeFileSync(log, 'browser flow passed\n');
  const base = {
    scores: [5, 5, 5, 5, 5],
    descriptions: [
      '导入和预览流程都能完成。',
      '原题要求的确认和取消操作已落实。',
      '先核对已有页面，再安排修改和检查。',
      '按实际提示定位了对应字段。',
      '逐步修改页面并完成检查。',
    ],
    other: '无',
    when: Array(5).fill('核对当前流程时'),
    behavior: Array(5).fill('按原题核对操作'),
    impact: Array(5).fill('可以完成原题操作'),
    expected: Array(5).fill('完成当前流程'),
    evidenceRefs: Array(5).fill(log + ':1'),
    processFindings: '本轮操作和原题要求相符。',
    artifactFindings: '浏览器检查已完成。',
  };
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  writeFileSync(
    path.join(dir, 'codex'),
    `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2);let input='';
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const out=args[args.indexOf('--output-last-message')+1],name=path.basename(out),fix=name.includes('.citations.');
 if(args.includes('--model')||args.includes('-m')||args[args.indexOf('--sandbox')+1]!=='read-only')throw Error('Wrong execution configuration');
 fs.appendFileSync(path.join(__dirname,'calls'),name+'\\n');
 const value=${JSON.stringify(base)};
 if(!name.startsWith('valid.')&&(!fix||name.startsWith('unresolved.')))value.evidenceRefs=Array(5).fill(${JSON.stringify(path.join(dir, 'questions', 'runtime.log') + ':1')});
 if(fix&&!input.includes('仅修复 evidenceRefs'))throw Error('Missing citation scope');
 if(fix&&name.startsWith('mutation.'))value.scores[0]=4;
 const contract=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
 const payload=contract.properties.patches?{patches:contract.properties.patches.items.properties.field.enum.map(field=>({field,value:field==='other'?value.other:value[field.split('[')[0]][Number(field.match(/[0-4]/)[0])]}))}:value;
 if(contract.properties.patches&&require('path').basename(out).startsWith('mutation.'))payload.scores=value.scores;
 fs.writeFileSync(out,JSON.stringify(payload));
 console.log(JSON.stringify({type:'thread.started',thread_id:name}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(payload)}}));
 console.log(JSON.stringify({type:'turn.completed'}));
});`,
    { mode: 0o700 },
  );
  process.env.PATH = dir + path.delimiter + oldPath;
  const run = (turnId) =>
    codexStage({
      stage: 'score',
      turnId,
      cwd,
      dir,
      prompt: '只读核对当前原件',
      onChild() {},
    });
  const valid = await run('valid');
  assert.deepEqual(valid.value, base);
  assert.equal(
    readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
    1,
  );
  const result = await run('repair');
  assert.deepEqual(result.value, base);
  assert.match(
    result.tracePath,
    /\.consistency\.citations\.score\.events\.jsonl$/,
  );
  assert.equal(result.consistencyRevision.originalTracePaths.length, 2);
  const initial = JSON.parse(
    readFileSync(path.join(dir, 'repair.consistency.score.json')),
  );
  assert.notDeepEqual(initial.evidenceRefs, result.value.evidenceRefs);
  const saved = {
    ...result,
    value: verifyScoreEvidence(result.value, cwd, dir),
  };
  const checkpoint = sealStage('score', saved, 'key', dir, [log]);
  assert.deepEqual(restoreStage('score', saved, checkpoint, 'key', dir), saved);
  await assert.rejects(run('mutation'), /评分补丁.*不能改动/);
  await assert.rejects(run('unresolved'), /评分引用文件不存在/);
  assert.equal(
    readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length,
    10,
  );
  assert.equal(readFileSync(log, 'utf8'), 'browser flow passed\n');
});
