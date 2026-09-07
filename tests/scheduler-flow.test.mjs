// Synthetic CLIs and isolated runner storage; never calls a real model.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  dir = path.join(root, '.runner', 'scheduler-fixture-' + Date.now()),
  bin = path.join(dir, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(path.join(bin, 'package.json'), '{"type":"commonjs"}');
writeFileSync(
  path.join(dir, 'resources.mjs'),
  `import os from 'node:os'; os.cpus=()=>Array(10).fill({model:'fixture'});os.totalmem=()=>32*2**30;os.freemem=()=>16*2**30;os.loadavg=()=>[1,1,1];os.platform=()=>'fixture';`,
);
const fixture = `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),a=process.argv.slice(2),name=path.basename(process.argv[1]),log=e=>fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({...e,time:Date.now(),cwd:process.cwd()})+'\\n');if(a.includes('--version')){console.log('fixture');process.exit(0)}
if(name==='gh'){if(a[0]==='repo')console.log(JSON.stringify({nameWithOwner:'fixture/repo',url:'https://github.com/fixture/repo',isPrivate:false,viewerPermission:'READ',defaultBranchRef:{name:'main'}}));else if(a.includes('user'))console.log('fixture-user');else console.log(JSON.stringify({sha:'a'.repeat(40),html_url:'https://github.com/fixture/repo/commit/'+'a'.repeat(40)}));process.exit(0)}\nif(name==='git'){if(a[0]==='rev-parse')console.log('a'.repeat(40));if(a[0]==='remote')console.log('https://github.com/fixture/repo.git');if(a[0]==='for-each-ref')console.log('refs/remotes/origin/main');if(a[0]==='worktree')fs.mkdirSync(a[3],{recursive:true});process.exit(0)}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(a.includes('--model')||a.includes('-m'))throw Error('unexpected model override');
if(name==='claude'){log({event:'start'});setTimeout(()=>{const v=JSON.parse(input);console.log(JSON.stringify({type:'system',subtype:'init',model:'fixture',session_id:v.session_id}));console.log(JSON.stringify({...v,uuid:'fixture-'+v.uuid}));console.log(JSON.stringify({type:'result',result:'Synthetic output',is_error:false}));log({event:'end'});},1500);return;}
const schema=a[a.indexOf('--output-schema')+1],out=a[a.indexOf('--output-last-message')+1],stage=['generate','policy','prepare','snapshot','score','delivery'].find(s=>schema.endsWith('.'+s+'.schema.json'));
const values={policy:{simpleFeatures:[],difficultyEvidence:['scope evidence','context evidence','interaction evidence','breadth evidence'],assessedDifficulty:'中等',followupFix:false,followupReason:'首轮或非产物修复',allowed:true,matchedRuleIds:[],duplicateTaskIds:[],checkedGroups:['games','desktop','business','dashboard'],reason:'synthetic eligible task'},generate:{title:'__SCHEDULER_FLOW_AUTO__',prompt:'Synthetic new task',category:'代码测试',difficulty:'中等',stack:'fixture'},prepare:{prompt:'Synthetic prepared task',category:'代码测试',difficulty:'中等',stack:'fixture',acceptance:['synthetic']},snapshot:{ready:true,head:'a'.repeat(40),remote:'https://github.com/fixture/repo.git',notes:['synthetic']},score:{scores:[3,3,3,3,3],descriptions:['a','b','c','d','e'],other:'无'},delivery:{passed:true,checks:['synthetic'],summary:'synthetic'}};log({event:stage});fs.writeFileSync(out,JSON.stringify(values[stage]));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));});`;
for (const name of ['git', 'claude', 'codex', 'gh']) {
  const p = path.join(bin, name);
  writeFileSync(p, fixture);
  chmodSync(p, 0o755);
}
async function api(route, body, method = 'POST') {
  const r = await fetch('http://localhost:3000' + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const original = (await api('/api/scheduler', null, 'GET')).config;
let runner;
const ids = [];
let errors = '';
try {
  await api('/api/scheduler', {
    ...original,
    enabled: true,
    useHistory: false,
    repos: [bin],
    concurrency: 3,
    dailyLimit: 1,
  });
  for (let i = 0; i < 3; i++) {
    const { task } = await api('/api/tasks', {
      title: '__SCHEDULER_FLOW__' + i,
      repoPath: bin,
      stack: 'fixture',
      category: '代码测试',
      difficulty: '中等',
      reproducibility: '无外部依赖',
      autoStart: true,
    });
    ids.push(task.id);
  }
  writeFileSync('.runner/scheduler-flow-ids', JSON.stringify(ids));
  runner = spawn(
    process.execPath,
    ['--import', path.join(dir, 'resources.mjs'), 'scripts/runner.mjs'],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        FIXTURE_LOG: path.join(dir, 'calls.jsonl'),
        RUNNER_WORK_ROOT: path.join(dir, 'runtime'),
        HOME: dir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  runner.stdout.on('data', () => {});
  runner.stderr.on('data', (c) => (errors += c));
  let completed = false;
  for (let i = 0; i < 160; i++) {
    const data = await api('/api/tasks', null, 'GET');
    const list = data.tasks.filter((t) => t.repoPath === bin);
    writeFileSync(
      '.runner/scheduler-flow-ids',
      JSON.stringify(list.map((t) => t.id)),
    );
    if (
      list.length === 4 &&
      list.every((t) => t.turns[0].status === 'review')
    ) {
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(
    completed,
    'all three parallel jobs and one automatic task should finish: ' + errors,
  );
  const events = readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  let active = 0,
    max = 0;
  for (const e of events) {
    if (e.event === 'start') max = Math.max(max, ++active);
    if (e.event === 'end') active--;
  }
  assert.equal(max, 3);
  assert.equal(active, 0);
  assert.equal(
    new Set(events.filter((e) => e.event === 'start').map((e) => e.cwd)).size,
    4,
  );
  assert.equal(events.filter((e) => e.event === 'generate').length, 1);
  console.log(
    'Runner flow passed: three overlapping Claude jobs, four isolated workspaces, automatic replenishment and daily quota, full Codex stages.',
  );
} finally {
  if (runner && runner.exitCode === null) {
    runner.kill('SIGTERM');
    await new Promise((r) => runner.on('close', r));
  }
  await api('/api/scheduler', original);
}
