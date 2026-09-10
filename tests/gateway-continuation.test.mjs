import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { completedGateway504 } from '../scripts/native-gateway-error.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
import {
  gatewayContinuationVersion as version,
  planGatewayContinuation,
  gatewayContinuationContext,
  recoveryRepairChecks,
} from '../lib/gateway-continuation.mjs';
import {
  claudeCallCount,
  canRepair,
  projectCounts,
} from '../lib/project-series.mjs';
import { dailyMix } from '../lib/workflow.mjs';
import { policySessionContext } from '../lib/policy-session-context.mjs';
import { sessionFinalization } from '../lib/session-finalization.mjs';
import { blocksProject } from '../lib/disputed-continuation.mjs';
import { continuationContext } from '../lib/round-context.mjs';
import { projectRegressionContext } from '../scripts/project-regression-context.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const duration = { type: 'system', subtype: 'turn_duration' };
const user = (id, text) => ({
  type: 'user',
  uuid: id,
  sessionId: 'session',
  message: { content: text },
});
const apiError = (code = 504) => ({
  type: 'assistant',
  uuid: 'api-error',
  isApiErrorMessage: true,
  error: 'server_error',
  message: {
    content: [
      { type: 'text', text: 'API Error: ' + code + ' Gateway Time-out' },
    ],
  },
});
const answer = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'completed' }] },
};
const raw = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function failureFixture() {
  const events = [user('native-first', '原始功能目标'), apiError(), duration];
  const first = {
    id: 'first',
    prompt: '原始功能目标',
    questionRootId: 'first',
    status: 'failed',
    executionOutcome: 'error',
    promptId: 'native-first',
    sessionId: 'session',
    category: '0-1 代码生成',
    difficulty: '困难',
    createdAt: '2026-09-10T00:00:00Z',
    claudeAttempts: ['first'],
    traceExport: { verified: true, sha256: sha(raw(events)) },
    permissionAudit: { passed: true },
    container: { containerId: 'container' },
    automation: {
      preparation: {
        value: {
          prompt: '原始功能目标',
          acceptance: ['验收原功能'],
          category: '0-1 代码生成',
          difficulty: '困难',
        },
      },
      policy: { accepted: true },
    },
  };
  first.gatewayFailure = {
    version,
    ...completedGateway504(events),
    promptId: first.promptId,
    sessionId: first.sessionId,
    traceSha256: first.traceExport.sha256,
  };
  const task = {
    id: 'task',
    container: {
      containerId: 'container',
      questionId: 'first',
      sessionId: 'session',
      status: 'running',
    },
    turns: [first],
  };
  return { events, first, task };
}
function enqueue(task, failed, id) {
  const next = planGatewayContinuation(task, failed, {
    id,
    callCount: claudeCallCount(task, 'first'),
  });
  assert.ok(next);
  failed.gatewayRecovery = { version, nextTurnId: next.id };
  task.turns.push(next);
  return next;
}

void test('only a final native 504 with resolved tools authorizes continuation', () => {
  assert.equal(completedGateway504([apiError(), duration]).status, 504);
  for (const events of [
    [apiError()],
    [apiError(502), duration],
    [apiError(503), duration],
    [{ ...apiError(), isApiErrorMessage: false }, duration],
    [apiError(), answer, duration],
    [apiError(), duration, answer],
    [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'pending' }] },
      },
      apiError(),
      duration,
    ],
    [
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'unknown',
              content: 'API Error: 504',
            },
          ],
        },
      },
      apiError(),
      duration,
    ],
  ])
    assert.equal(completedGateway504(events), null);
  assert.ok(
    completedGateway504([
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'done' }] },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'done', content: 'done' },
          ],
        },
      },
      apiError(),
      duration,
    ]),
  );
});

void test('504 failure and next actual continue stay separate; no premature cleanup or ordinary retry exception', () => {
  const { task, first } = failureFixture();
  const previousResult = JSON.stringify(first);
  const next = enqueue(task, first, 'second');
  assert.equal(first.status, 'failed');
  assert.equal(first.promptId, 'native-first');
  assert.equal(next.prompt, '继续');
  assert.equal(next.promptId, undefined);
  assert.equal(next.roundNumber, 2);
  assert.equal(next.repairOf, undefined);
  assert.equal(
    gatewayContinuationContext(task, next).evaluationPrompt,
    first.prompt,
  );
  assert.equal(
    planGatewayContinuation(task, first, { id: 'duplicate', callCount: 1 }),
    null,
  );
  assert.equal(sessionFinalization(task), null);
  assert.equal(blocksProject(first), false);
  assert.equal(
    JSON.stringify({ ...first, gatewayRecovery: undefined }),
    previousResult,
  );
  assert.throws(
    () =>
      continuationContext(
        {
          turns: [
            first,
            { id: 'ordinary', prompt: '继续', continuationOf: first.id },
          ],
        },
        { id: 'ordinary', prompt: '继续', continuationOf: first.id },
      ),
    /已完成/,
  );
  next.gatewayContinuation.sessionId = 'other';
  assert.throws(() => gatewayContinuationContext(task, next), /原生身份/);
});

void test('permissions, missing evidence, changed container, and ten calls cannot enqueue', () => {
  for (const edit of [
    ({ task }) => (task.closed = true),
    ({ first }) => (first.permissionAudit.passed = false),
    ({ first }) => (first.traceExport.verified = false),
    ({ task }) => (task.container.containerId = 'foreign'),
    ({ task }) => (task.container.status = 'removed'),
    ({ first }) => (first.automation.policy.accepted = false),
    ({ first }) => (first.gatewayFailure.status = 503),
  ]) {
    const f = failureFixture();
    edit(f);
    assert.equal(
      planGatewayContinuation(f.task, f.first, { id: 'next', callCount: 1 }),
      null,
    );
  }
  const { task, first } = failureFixture();
  assert.equal(
    planGatewayContinuation(task, first, { id: 'eleventh', callCount: 10 }),
    null,
  );
});

void test('504 during Bug1 does not consume Bug2 or inflate type proportions', () => {
  const { task, first } = failureFixture();
  first.category = 'Bug 修复';
  first.repairOf = 'root';
  first.questionRootId = 'root';
  task.container.questionId = 'root';
  task.turns.unshift({
    id: 'root',
    questionRootId: 'root',
    category: '0-1 代码生成',
    status: 'review',
    claudeAttempts: ['root'],
    createdAt: first.createdAt,
  });
  const next = enqueue(task, first, 'continue-bug');
  next.status = 'review';
  next.sessionId = 'session';
  next.promptId = 'native-continue';
  next.claudeAttempts = ['continue-bug'];
  const ctx = policySessionContext(task, next);
  assert.equal(ctx.recordedLogicalTurns, 2);
  assert.equal(ctx.recordedBugRepairs, 1);
  assert.equal(ctx.sentClaudeCalls, 3);
  assert.equal(canRepair(task, next), true);
  assert.equal(projectCounts(task)['0-1 代码生成'], 1);
  assert.equal(dailyMix([task], '2026-09-10').totals['Bug 修复'], 1);
  task.turns[0].automation = {
    next: { value: { prompt: first.prompt, repairCheckIds: ['selected-bug'] } },
  };
  assert.deepEqual(recoveryRepairChecks(task, next, task.turns[0]), [
    'selected-bug',
  ]);
  assert.equal(
    recoveryRepairChecks(task, next, task.turns[0]).includes(
      'unselected-regression',
    ),
    false,
  );
});

void test('consecutive 504s send once each in the original session with distinct real IDs', async (t) => {
  const { task, first, events } = failureFixture();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = {
    taskId: task.id,
    containerId: 'container',
    sessionId: 'session',
    results: { first: { ...first, success: false } },
  };
  const original = JSON.stringify(state.results.first);
  const sent = [],
    reservations = new Set(['first']);
  let current,
    shouldFail = true;
  const rt = Object.create(DockerRuntime.prototype);
  rt.ensure = async () => state;
  rt.shouldStop = () => false;
  rt.owned = () => ({ State: { Running: true } });
  rt.native = () => [{ name: 'session.jsonl', content: raw(events) }];
  rt.export = async () => ({ verified: true, sha256: sha(raw(events)) });
  rt.permissionAudit = () => ({ passed: true });
  rt.file = () => path.join(dir, 'container.json');
  rt.save = () => {};
  rt.publish = async () => {};
  rt.public = () => task.container;
  rt.live = new Map([
    [
      task.id,
      {
        child: {
          stdin: {
            write: async (text) => {
              sent.push(text);
              if (text === '\r')
                events.push(
                  user('native-' + current.id, current.prompt),
                  shouldFail ? apiError() : answer,
                  duration,
                );
            },
          },
        },
      },
    ],
  ]);
  const reserve = async (id) => {
    reservations.add(id);
    return { allowed: true, count: reservations.size };
  };
  let previous = first;
  for (let i = 1; i <= 3; i++) {
    current = enqueue(task, previous, 'continue-' + i);
    shouldFail = i < 3;
    const result = await rt.execute(task, current, reserve);
    Object.assign(current, result, {
      status: result.success ? 'review' : 'failed',
      claudeAttempts: [current.id],
      automation: structuredClone(previous.automation),
    });
    assert.equal(result.promptId, 'native-' + current.id);
    assert.equal(result.claudeCallCount, i + 1);
    assert.equal(result.sessionId, 'session');
    assert.equal(state.pending, undefined);
    previous = current;
  }
  assert.equal(sent.filter((s) => s === '\r').length, 3);
  assert.equal(state.results[current.id].success, true);
  assert.equal(JSON.stringify(state.results.first), original);
  const count = sent.length;
  await rt.execute(task, current, () =>
    assert.fail('saved result cannot reserve again'),
  );
  assert.equal(sent.length, count);
  assert.match(
    readFileSync(path.join(dir, current.id + '.native.jsonl'), 'utf8'),
    /native-continue-1/,
  );
});

void test('a queued 504 continue whose input was sent before a crash is observed without resending', async (t) => {
  const { task, first, events } = failureFixture();
  const next = enqueue(task, first, 'second');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-pending-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  events.push(user('native-second', '继续'), answer, duration);
  const state = {
    taskId: 'task',
    sessionId: 'session',
    results: { first: { ...first, success: false } },
    pending: {
      turnId: next.id,
      promptHash: sha('继续'),
      previousIds: ['native-first'],
      phase: 'sent',
      count: 2,
    },
  };
  const rt = Object.create(DockerRuntime.prototype);
  Object.assign(rt, {
    ensure: async () => state,
    shouldStop: () => false,
    owned: () => ({ State: { Running: true } }),
    native: () => [{ name: 'native', content: raw(events) }],
    export: async () => ({ verified: true }),
    permissionAudit: () => ({ passed: true }),
    file: () => path.join(dir, 'container.json'),
    save: () => {},
    publish: async () => {},
    public: () => task.container,
  });
  const result = await rt.execute(task, next, () =>
    assert.fail('must not reserve'),
  );
  assert.equal(result.promptId, 'native-second');
  assert.equal(result.success, true);
  assert.equal(result.claudeCallCount, 2);
});

void test('failed 504 rounds do not invent missing business verification reports', (t) => {
  const { task, first } = failureFixture();
  const next = enqueue(task, first, 'second');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gateway-regression-'));
  const taskDir = path.join(dir, task.id);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return import('node:fs').then(({ mkdirSync }) => {
    mkdirSync(taskDir);
    assert.equal(
      projectRegressionContext(task, next, { dir: taskDir, imageId: 'image' }),
      null,
    );
  });
});
