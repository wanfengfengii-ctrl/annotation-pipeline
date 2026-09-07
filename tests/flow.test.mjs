import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  bin = path.join(root, '.runner', 'flow-test-bin');
mkdirSync(bin, { recursive: true });
writeFileSync(
  path.join(bin, 'package.json'),
  JSON.stringify({ type: 'commonjs' }),
);
const calls = path.join(bin, 'calls.jsonl');
writeFileSync(calls, '');
writeFileSync(path.join(bin, 'fail-score-once'), '1');
const fixture = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const name=path.basename(process.argv[1]),a=process.argv.slice(2),dir=process.env.FIXTURE_BIN;const sha='a'.repeat(40);if(a.includes('--version')){console.log(name+' fixture');process.exit(0)}
if(name==='git'){if(a[0]==='rev-parse')console.log(sha);if(a[0]==='remote')console.log('https://github.com/fixture/fixture.git');if(a[0]==='for-each-ref')console.log('refs/remotes/origin/main');if(a[0]==='worktree')fs.mkdirSync(a[3],{recursive:true});process.exit(0)}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(a.includes('--model')||a.includes('-m'))throw Error('Model override is forbidden');
if(name==='claude'){fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:'claude'})+'\\n');const v=JSON.parse(input);console.log(JSON.stringify({type:'system',subtype:'init',model:'fixture-config-model',session_id:v.session_id}));console.log(JSON.stringify({...v,uuid:'fixture-user-message'}));console.log(JSON.stringify({type:'result',result:'Synthetic fixture output',is_error:false}));return}
const schema=a[a.indexOf('--output-schema')+1],out=a[a.indexOf('--output-last-message')+1];const stage=['prepare','snapshot','score','delivery'].find(x=>schema.endsWith('.'+x+'.schema.json'));fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:stage})+'\\n');if(stage==='score'&&fs.existsSync(dir+'/fail-score-once')){fs.unlinkSync(dir+'/fail-score-once');process.exit(1)}
const values={prepare:{prompt:'Synthetic prepared goal',category:'Feature 迭代',difficulty:'中等',stack:'fixture',acceptance:['fixture evidence']},snapshot:{ready:true,head:sha,remote:'https://github.com/fixture/fixture.git',notes:['fixture snapshot']},score:{scores:[3,3,3,3,3],descriptions:['a','b','c','d','e'],other:'无'},delivery:{passed:true,checks:['fixture data complete'],summary:'synthetic verification'}};fs.writeFileSync(out,JSON.stringify(values[stage]));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-'+stage}));});
`;
for (const name of ['git', 'codex', 'claude']) {
  const p = path.join(bin, name);
  writeFileSync(p, fixture);
  chmodSync(p, 0o755);
}
async function api(route, body, method = 'POST') {
  const res = await fetch('http://localhost:3000' + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await res.json();
  if (!res.ok) throw Error(v.error);
  return v;
}
const { task } = await api('/api/tasks', {
  title: '__CODEX_FLOW_TEST__',
  repoPath: bin,
  stack: 'fixture',
  category: 'Feature 迭代',
  difficulty: '中等',
  reproducibility: '无外部依赖',
  autoStart: true,
});
writeFileSync('.runner/flow-test-id', task.id);
const runner = spawn(process.execPath, ['scripts/runner.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    FIXTURE_BIN: bin,
    HOME: bin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let errors = '';
runner.stderr.on('data', (c) => (errors += c));
runner.stdout.on('data', () => {});
async function waitStatus(status) {
  for (let i = 0; i < 120; i++) {
    const t = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === task.id,
    );
    if (t.turns[0]?.status === status) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error('Timed out waiting ' + status + ' ' + errors);
}
try {
  let t = await waitStatus('failed');
  assert.equal(t.turns[0].stage, 'score');
  assert.equal(t.turns[0].requestedPrompt, '__CODEX_FLOW_TEST__');
  await api(
    '/api/tasks/' + task.id,
    { action: 'retry', turnId: t.turns[0].id, revision: t.revision },
    'PATCH',
  );
  t = await waitStatus('review');
  const r = t.turns[0];
  assert.equal(r.review.source, 'codex');
  assert.equal(r.review.attested, false);
  assert.equal(r.automation.delivery.value.passed, true);
  assert.ok(
    readFileSync(r.automation.bundlePath, 'utf8').includes('AI-generated'),
  );
  const log = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x).name);
  assert.equal(log.filter((x) => x === 'claude').length, 1);
  assert.equal(log.filter((x) => x === 'prepare').length, 1);
  assert.equal(log.filter((x) => x === 'score').length, 2);
  assert.equal(log.filter((x) => x === 'delivery').length, 1);
  assert.ok(!r.jobToken && !r.completedJobToken);
  console.log(
    'Full fixture pipeline passed, including score failure and resume without rerunning Claude.',
  );
} finally {
  if (runner.exitCode === null) {
    runner.kill('SIGTERM');
    await new Promise((r) => runner.on('close', r));
  }
  if (errors) console.error(errors);
}
