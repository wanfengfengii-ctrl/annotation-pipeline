import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
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
rmSync(path.join(bin, 'project-mode'), { force: true });
writeFileSync(path.join(bin, 'fail-score-once'), '1');
const fixture = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const name=path.basename(process.argv[1]),a=process.argv.slice(2),dir=process.env.FIXTURE_BIN;const sha='a'.repeat(40);if(a.includes('--version')){console.log(name+' fixture');process.exit(0)}
if(name==='gh'){if(a[0]==='repo')console.log(JSON.stringify({nameWithOwner:'fixture/fixture',url:'https://github.com/fixture/fixture',isPrivate:false,viewerPermission:'READ',defaultBranchRef:{name:'main'}}));else if(a.includes('user'))console.log('fixture-user');else console.log(JSON.stringify({sha:'a'.repeat(40),html_url:'https://github.com/fixture/fixture/commit/'+'a'.repeat(40)}));process.exit(0)}\nif(name==='git'){if(a[0]==='rev-parse')console.log(sha);if(a[0]==='remote')console.log('https://github.com/fixture/fixture.git');if(a[0]==='for-each-ref')console.log('refs/remotes/origin/main');if(a[0]==='worktree')fs.mkdirSync(a[3],{recursive:true});process.exit(0)}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(a.includes('--model')||a.includes('-m'))throw Error('Model override is forbidden');
if(name==='claude'){fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:'claude',cwd:process.cwd(),session:JSON.parse(input).session_id,args:a})+'\\n');const v=JSON.parse(input);if(fs.existsSync(dir+'/project-mode')){const f='.fixture-round-count',n=fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0;fs.writeFileSync(f,String(n+1));const project=(input.match(/projects\\/p-[a-f0-9-]{36}/)||[])[0];if(!project)throw Error('Missing project directory');fs.mkdirSync(project,{recursive:true});fs.writeFileSync(project+'/engine.ts','// synthetic project round '+(n+1));}console.log(JSON.stringify({type:'system',subtype:'init',model:'fixture-config-model',session_id:v.session_id}));console.log(JSON.stringify({...v,uuid:'fixture-'+v.uuid}));console.log(JSON.stringify({type:'result',result:'Synthetic fixture output',is_error:false}));return}
const schema=a[a.indexOf('--output-schema')+1],out=a[a.indexOf('--output-last-message')+1];const stage=['policy','prepare','snapshot','score','delivery','next','project-next'].find(x=>schema.endsWith('.'+x+'.schema.json'));fs.appendFileSync(dir+'/calls.jsonl',JSON.stringify({name:stage})+'\\n');if(stage==='score'&&fs.existsSync(dir+'/fail-score-once')){fs.unlinkSync(dir+'/fail-score-once');process.exit(1)}
const count=fs.existsSync('.fixture-round-count')?Number(fs.readFileSync('.fixture-round-count','utf8')):0;const cats=['0-1 代码生成','Feature 迭代','Bug 修复','代码理解','代码重构','Feature 迭代','Bug 修复','代码理解','代码重构','Feature 迭代'];const values={'project-next':{action:cats[count]==='Bug 修复'?'repair':'advance',prompt:'Synthetic project round '+(count+1),category:cats[count]||'Feature 迭代',difficulty:'中等',reason:'synthetic file evidence',baseComplete:true,projectEvidence:'projects directory engine.ts fixture'},policy:{simpleFeatures:input.includes('用户原目标：__FOLLOWUP_FIX__')?['scope','breadth']:[],difficultyEvidence:['scope evidence','context evidence','interaction evidence','breadth evidence'],assessedDifficulty:input.includes('用户原目标：__FOLLOWUP_FIX__')?'简单':'中等',followupFix:input.includes('用户原目标：__FOLLOWUP_FIX__'),followupReason:'首轮或非产物修复',allowed:!input.includes('用户原目标：__POLICY_REJECT__'),matchedRuleIds:input.includes('用户原目标：__POLICY_REJECT__')?['games']:[],duplicateTaskIds:[],checkedGroups:['games','desktop','business','dashboard'],reason:'synthetic eligible task'},prepare:{prompt:'Synthetic prepared goal '+count,category:input.includes('项目连续出题规则')?cats[count]:'Feature 迭代',difficulty:'中等',stack:'fixture',acceptance:['fixture evidence']},snapshot:{environmentLevel:'无外部依赖',dependencies:[],startup:'fixture',verification:'fixture',ready:true,head:sha,remote:'https://github.com/fixture/fixture.git',notes:['fixture snapshot']},next:{action:fs.existsSync(dir+'/auto-next')?'repair':'complete',prompt:'__AUTO_REPAIR__ repair boundary',reason:'fixture follow-up'},score:{when:Array(5).fill('fixture step'),behavior:Array(5).fill('fixture behavior'),impact:Array(5).fill('fixture impact'),expected:Array(5).fill('fixture expected'),evidenceRefs:Array(5).fill((input.match(/本轮轨迹文件：([^\\n]+)/)||[])[1]+':1'),processFindings:'fixture',artifactFindings:'fixture',scores:[3,3,3,3,3],descriptions:['a','b','c','d','e'],other:'无'},delivery:{passed:true,checks:['fixture data complete'],summary:'synthetic verification'}};if(stage==='next'&&fs.existsSync(dir+'/auto-next'))fs.unlinkSync(dir+'/auto-next');fs.writeFileSync(out,JSON.stringify(values[stage]));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-'+stage}));});
`;
for (const name of ['git', 'codex', 'claude', 'gh']) {
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
  const blocked = (
    await api('/api/tasks', {
      title: '__POLICY_REJECT__',
      repoPath: bin,
      stack: 'fixture',
      category: 'Feature 迭代',
      difficulty: '中等',
      reproducibility: '无外部依赖',
      autoStart: true,
    })
  ).task;
  writeFileSync('.runner/policy-blocked-test-id', blocked.id);
  let rejected;
  for (let i = 0; i < 120; i++) {
    rejected = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === blocked.id,
    );
    if (rejected.turns[0].status === 'failed') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(rejected.turns[0].stage, 'policy');
  assert.equal(rejected.turns[0].automation.policy.value.allowed, false);
  assert.equal(
    readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((x) => x.name === 'claude').length,
    1,
    'blocked task must never reach Claude',
  );
  t = (await api('/api/tasks', null, 'GET')).tasks.find(
    (t) => t.id === task.id,
  );
  await api(
    '/api/tasks/' + task.id,
    {
      action: 'enqueue',
      prompt: '__FOLLOWUP_FIX__ 修复前轮产物的边界判断',
      category: 'Bug 修复',
      difficulty: '简单',
      revision: t.revision,
    },
    'PATCH',
  );
  for (let i = 0; i < 120; i++) {
    t = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === task.id,
    );
    if (['failed', 'review'].includes(t.turns[1].status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(t.turns[1].status, 'review', t.turns[1].error);
  assert.equal(t.turns[1].difficulty, '简单');
  assert.equal(t.turns[1].automation.policy.roundContext.firstTurn, false);
  assert.equal(
    t.turns[1].automation.policy.roundContext.allowFollowupFix,
    true,
  );
  assert.equal(t.turns[1].automation.policy.accepted, true);
  writeFileSync(path.join(bin, 'auto-next'), '1');
  const auto = (
    await api('/api/tasks', {
      title: '__AUTO_CONTINUATION__',
      repoPath: bin,
      stack: 'fixture',
      category: 'Feature 迭代',
      difficulty: '中等',
      reproducibility: '无外部依赖',
      autoStart: true,
    })
  ).task;
  writeFileSync('.runner/auto-continuation-id', auto.id);
  let follow;
  for (let i = 0; i < 160; i++) {
    follow = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === auto.id,
    );
    if (follow.turns.length === 2 && follow.turns[1].status === 'review') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(follow.turns.length, 2);
  assert.equal(follow.turns[1].status, 'review', follow.turns[1].error);
  assert.equal(follow.turns[1].autoFollowup, true);
  assert.equal(follow.turns[0].sessionId, follow.turns[1].sessionId);
  assert.notEqual(follow.turns[0].promptId, follow.turns[1].promptId);
  assert.ok(
    follow.turns.every(
      (r) => r.automation.archive && r.review.source === 'codex',
    ),
  );
  writeFileSync(path.join(bin, 'project-mode'), '1');
  const series = (
    await api('/api/tasks', {
      title: '__PROJECT_SERIES_FLOW__',
      repoPath: bin,
      stack: 'fixture',
      category: '0-1 代码生成',
      difficulty: '中等',
      reproducibility: '无外部依赖',
      projectSeries: true,
      autoStart: true,
    })
  ).task;
  writeFileSync('.runner/project-series-flow-id', series.id);
  let project;
  for (let i = 0; i < 300; i++) {
    project = (await api('/api/tasks', null, 'GET')).tasks.find(
      (t) => t.id === series.id,
    );
    if (project.turns.some((r) => r.status === 'failed'))
      throw Error(project.turns.find((r) => r.status === 'failed').error);
    if (project.turns.length === 10 && project.turns[9].status === 'review')
      break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(project.turns.length, 10);
  assert.ok(
    project.turns.every(
      (r) =>
        r.status === 'review' &&
        r.review.source === 'codex' &&
        r.automation.archive,
    ),
  );
  assert.deepEqual(
    project.turns.map((r) => r.category),
    [
      '0-1 代码生成',
      'Feature 迭代',
      'Bug 修复',
      '代码理解',
      '代码重构',
      'Feature 迭代',
      'Bug 修复',
      '代码理解',
      '代码重构',
      'Feature 迭代',
    ],
  );
  const projectCalls = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((e) => e.name === 'claude' && e.cwd === project.workDir);
  assert.equal(projectCalls.length, 10);
  assert.equal(new Set(projectCalls.map((e) => e.session)).size, 1);
  assert.ok(projectCalls[0].args.includes('--session-id'));
  assert.ok(projectCalls.slice(1).every((e) => e.args.includes('--resume')));
  assert.equal(
    project.turns.reduce((n, r) => n + r.claudeAttempts.length, 0),
    10,
  );
  assert.match(
    readFileSync(
      path.join(project.workDir, project.projectSeries.directory, 'engine.ts'),
      'utf8',
    ),
    /round 10/,
  );
  const capped = await api('/api/tasks', null, 'GET');
  assert.equal(capped.tasks.find((t) => t.id === series.id).turns.length, 10);
  console.log(
    'Full fixture pipeline passed: score retry reuses Claude; policy block; automatic continuation; one project/session across 10 independently scored rounds and no 11th call.',
  );
} finally {
  if (runner.exitCode === null) {
    runner.kill('SIGTERM');
    await new Promise((r) => runner.on('close', r));
  }
  if (errors) console.error(errors);
}
