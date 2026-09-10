// This test requires a separate synthetic database on localhost:3001.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { base } from './fixtures/test-server.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { gatewayContinuationVersion as version } from '../lib/gateway-continuation.mjs';
import { permissionAuditVersion } from '../lib/permission-audit.mjs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
async function api(route, body, method = 'POST') {
  const response = await fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}
const run = (body) => api('/api/runner', body);
const config = (await api('/api/scheduler', null, 'GET')).config;
const current = async (id) =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
await api('/api/scheduler', {
  ...config,
  enabled: false,
  autoContinue: false,
  concurrency: 1,
});
try {
  const { task } = await api('/api/tasks', {
    title: '__GATEWAY504__',
    repoPath: '/tmp/gateway-synthetic',
    stack: 'TypeScript',
    category: '0-1 代码生成',
    difficulty: '困难',
    reproducibility: '无外部依赖',
    autoStart: true,
  });
  let { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, task.id);
  const container = {
    taskId: task.id,
    questionId: job.turn.id,
    name: 'annotation-' + task.id,
    containerId: 'a'.repeat(64),
    image: containerImage,
    imageId: 'sha256:' + 'b'.repeat(64),
    snapshot: dockerSnapshot('sha256:' + 'b'.repeat(64)),
    policyVersion: containerPolicyVersion,
    status: 'running',
    workDir: '/fixture/' + task.id + '/workspace',
    terminalIdentity: {
      transport: 'mac-terminal',
      runId: job.turn.id,
      realTerminal: true,
      tty: '/dev/fixture',
    },
  };
  await run({ action: 'container', taskId: task.id, container });
  const firstId = job.turn.id;
  const originalPrompt = job.turn.prompt;
  const sessionId = 'gateway-test-session';
  for (let count = 1; count <= 10; count++) {
    const attemptId = job.turn.id;
    const quota = await run({
      action: 'reserve-claude',
      taskId: task.id,
      turnId: job.turn.id,
      jobToken: job.turn.jobToken,
      attemptId,
      ...(count > 1 ? { sessionId } : {}),
    });
    assert.equal(quota.count, count);
    assert.equal(
      (
        await run({
          action: 'reserve-claude',
          taskId: task.id,
          turnId: job.turn.id,
          jobToken: job.turn.jobToken,
          attemptId,
          ...(count > 1 ? { sessionId } : {}),
        })
      ).count,
      count,
    );
    const failure = {
      action: 'finish',
      taskId: task.id,
      turnId: job.turn.id,
      jobToken: job.turn.jobToken,
      success: false,
      executionOutcome: 'error',
      sessionId,
      promptId: 'native-' + count,
      container: { ...container, sessionId },
      stage: 'claude',
      error: 'Claude 原始轨迹报告调用错误',
      output: 'API Error: 504',
      tracePath: '/fixture/' + task.id + '/native-' + count,
      traceExport: {
        verified: true,
        path: '/fixture/projects',
        files: 1,
        sha256: 'c'.repeat(64),
      },
      permissionAudit: {
        version: permissionAuditVersion,
        passed: true,
        modeVerified: true,
        denialCount: 0,
        traceSha256: 'c'.repeat(64),
      },
      gatewayFailure: {
        version,
        status: 504,
        eventSha256: 'd'.repeat(64),
        traceSha256: 'c'.repeat(64),
        promptId: 'native-' + count,
        sessionId,
      },
      evaluationPrompt: originalPrompt,
      automation: {
        preparation: {
          value: {
            prompt: job.turn.prompt,
            category: '0-1 代码生成',
            difficulty: '困难',
            acceptance: ['原任务验收'],
          },
        },
        policy: { accepted: true },
      },
    };
    await run(failure);
    await run(failure);
    const saved = await current(task.id);
    assert.equal(saved.turns[0].status, 'failed');
    assert.equal(saved.turns[0].prompt, originalPrompt);
    assert.equal(saved.turns[0].promptId, 'native-1');
    assert.equal(saved.turns.length, Math.min(count + 1, 10));
    const context = await run({ action: 'supply-context' });
    const queued = saved.turns.at(-1);
    if (count < 10) {
      assert.equal(queued.prompt, '继续');
      assert.equal(queued.continuationOf, job.turn.id);
      assert.equal(queued.questionRootId, firstId);
      assert.equal(queued.roundNumber, count + 1);
      assert.equal(queued.repairOf, undefined);
      assert.equal(queued.status, 'queued');
      assert.equal(
        context.containerTasks.find((t) => t.id === task.id)?.finalization ??
          null,
        null,
      );
      ({ job } = await run({ action: 'claim', capacity: 1 }));
      assert.equal(job.turn.id, queued.id);
      assert.equal(job.turn.roundNumber, count + 1);
    } else {
      assert.equal(queued.status, 'failed');
      assert.equal((await run({ action: 'claim', capacity: 1 })).job, null);
    }
  }
  console.log(
    '504 API: 原子排队与 finish 重放幂等、连续9次继续、真实轮次、十次调用封顶均通过',
  );
} finally {
  await api('/api/scheduler', config);
}
