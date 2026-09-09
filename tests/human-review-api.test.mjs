import { base } from './fixtures/test-server.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { draftFromAI } from '../lib/human-review.ts';
const token = readFileSync('.dev.vars', 'utf8').match(
    /^RUNNER_TOKEN=(.+)$/m,
  )[1],
  ids = [];
async function api(route, body, method = 'POST', auth = false) {
  const res = await fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!res.ok) throw Error(d.error);
  return d;
}
const run = (b) => api('/api/runner', b, 'POST', true),
  getTask = async (id) =>
    (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
const original = (await api('/api/scheduler', null, 'GET')).config;
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    autoContinue: true,
    concurrency: 1,
  });
  const { task } = await api('/api/tasks', {
    title: '__HUMAN_CONFIRM_API__',
    repoPath: '/tmp/human-confirm-fixture',
    stack: 'fixture',
    category: 'Feature 迭代',
    difficulty: '中等',
    reproducibility: '无外部依赖',
    autoStart: true,
  });
  ids.push(task.id);
  writeFileSync('.runner/human-review-test-ids', JSON.stringify(ids));
  let { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, task.id);
  const review = {
    source: 'codex',
    scores: [2, 3, 4, 4, 5],
    descriptions: ['a', 'b', 'c', 'd', 'e'],
    when: Array(5).fill('执行时'),
    behavior: ['保存错误', '约束检查', '规划检查', '推理检查', '工具检查'],
    impact: Array(5).fill('实际影响'),
    expected: Array(5).fill('正确做法'),
    evidenceRefs: Array(5).fill('output:1'),
    processFindings: '轨迹检查结果',
    artifactFindings: '产物检查结果',
    other: '无',
  };
  const finish = {
    action: 'finish',
    taskId: task.id,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    success: true,
    output: '真实测试中的模拟输出',
    promptId: 'prompt-one',
    sessionId: 'session',
    tracePath: '/fixture/trace',
    snapshot: 'https://github.com/a/b/commit/' + 'a'.repeat(40),
    harnessVersion: 'fixture',
    os: 'fixture',
    review,
    automation: {
      next: {
        value: {
          action: 'repair',
          prompt: '下一轮独立目标',
          reason: '自动继续',
        },
      },
    },
  };
  await run(finish);
  let t = await getTask(task.id),
    r = t.turns[0];
  assert.equal(
    t.turns.length,
    2,
    'AI pipeline must not wait for human confirmation',
  );
  ({ job } = await run({ action: 'claim', capacity: 1 }));
  assert.equal(
    job.turn.id,
    t.turns[1].id,
    'next turn can execute before any human review',
  );
  await run({
    ...finish,
    turnId: job.turn.id,
    jobToken: job.turn.jobToken,
    promptId: 'prompt-two',
    automation: {
      next: { value: { action: 'complete', prompt: '无', reason: '完成' } },
    },
  });
  const confirm = async (action, extra = {}, turnId = r.id) => {
    const latest = await getTask(task.id);
    return api(`/api/tasks/${task.id}/human-review`, {
      action,
      turnId,
      revision: latest.revision,
      ...extra,
    });
  };
  let d = draftFromAI(r);
  d.reviewer = '测试确认人';
  await assert.rejects(
    () => confirm('finalize', { draft: d }),
    /实际|核对|确认/,
  );
  d.verification = '实际执行命令并检查产物';
  d.attested = true;
  d.findings[0].evidenceRefs = 'output:999';
  await assert.rejects(() => confirm('finalize', { draft: d }), /不存在/);
  d.findings[0].evidenceRefs = 'output:1';
  await confirm('save', { draft: d });
  const stale = await getTask(task.id);
  await confirm('finalize', { draft: d });
  t = await getTask(task.id);
  assert.equal(t.turns[0].humanReview.state, 'needs_second_review');
  assert.equal(t.turns[0].review.attested, false);
  d.qualityResolution = '复现保存失败，核对错误日志，低分归因符合实际';
  d.findings[1].score = 4;
  await confirm('finalize', { draft: d });
  await assert.rejects(
    () =>
      api(`/api/tasks/${task.id}/human-review`, {
        action: 'save',
        turnId: r.id,
        revision: stale.revision,
        draft: d,
      }),
    /更新/,
  );
  let hist = await api(
    `/api/tasks/${task.id}/human-review?turnId=${r.id}`,
    null,
    'GET',
  );
  assert.equal(hist.history.length, 3, 'stale write must not create history');
  assert.deepEqual(hist.originalAI.scores, review.scores);
  assert.equal(hist.confirmation.draft.findings[1].score, 4);
  await assert.rejects(
    () =>
      confirm('receipt', {
        receipt: 'fixture-only',
        actor: d.reviewer,
        allRoundsChecked: true,
      }),
    /还有 1/,
  );
  let d2 = draftFromAI((await getTask(task.id)).turns[1]);
  Object.assign(d2, {
    reviewer: d.reviewer,
    verification: '核对第二轮实际结果',
    attested: true,
    qualityResolution: d.qualityResolution,
  });
  await confirm('finalize', { draft: d2 }, t.turns[1].id);
  await confirm('return', { actor: d.reviewer, reason: '补充边界测试证据' });
  assert.equal(
    (await getTask(task.id)).turns[0].humanReview.state,
    'needs_revision',
  );
  await confirm('finalize', { draft: d });
  const csv = await (await fetch(base + '/api/export?source=human')).text();
  assert.match(csv, /人工复核（已有 AI 评估）/);
  assert.match(csv, /__HUMAN_CONFIRM_API__/);
  await confirm('receipt', {
    receipt: 'synthetic://confirmation-receipt',
    actor: d.reviewer,
    allRoundsChecked: true,
  });
  await assert.rejects(() => confirm('save', { draft: d }), /锁定/);
  t = await getTask(task.id);
  await assert.rejects(
    () =>
      api(
        '/api/tasks/' + t.id,
        {
          action: 'exclude',
          turnId: r.id,
          revision: t.revision,
          reason: 'fake',
        },
        'PATCH',
      ),
    /锁定/,
  );
  hist = await api(
    `/api/tasks/${task.id}/human-review?turnId=${r.id}&download=1`,
    null,
    'GET',
  );
  assert.ok(hist.history.some((v) => v.action === 'receipt'));
  assert.deepEqual(hist.originalAI.scores, review.scores);
  console.log(
    'Human confirmation API passed: AI continues immediately; actual verification required; low-score review, evidence references, immutable audit, CAS, all-round completeness, export provenance and receipt lock.',
  );
} finally {
  await api('/api/scheduler', original);
}
