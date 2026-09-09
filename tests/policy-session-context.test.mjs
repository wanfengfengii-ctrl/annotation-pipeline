import test from 'node:test';
import assert from 'node:assert/strict';
import { policySessionContext } from '../lib/policy-session-context.mjs';

const sent = (id, root, sessionId, repairOf) => ({
  id,
  questionRootId: root,
  sessionId,
  promptId: id + '-prompt',
  claudeAttempts: [{ promptId: id + '-prompt' }],
  repairOf,
  category: repairOf ? 'Bug 修复' : '0-1 代码生成',
  status: 'review',
});
function fixture() {
  const turn = {
    id: 'ui-repair-two',
    questionRootId: 'ui',
    repairOf: 'ui-repair-one',
    category: 'Bug 修复',
    status: 'failed',
    stage: 'policy',
  };
  return {
    turn,
    task: {
      container: { questionId: 'ui', sessionId: 'native-ui' },
      turns: [
        sent('backend', 'backend', 'native-backend'),
        sent('backend-repair', 'backend', 'native-backend', 'backend'),
        {
          id: 'excluded-feature',
          category: 'Feature 迭代',
          status: 'failed',
          excluded: true,
        },
        sent('ui', 'ui', 'native-ui'),
        sent('ui-repair-one', 'ui', 'native-ui', 'ui'),
        turn,
      ],
    },
  };
}

test('the second Bug of a new question uses three logical turns and two sent calls despite older project repairs', () => {
  const { task, turn } = fixture();
  const original = structuredClone(task);
  const context = policySessionContext(task, turn);
  assert.equal(context.questionRootId, 'ui');
  assert.equal(context.sessionId, 'native-ui');
  assert.equal(context.currentLogicalTurn, 3);
  assert.equal(context.currentBugRepairOrdinal, 2);
  assert.equal(context.recordedLogicalTurns, 3);
  assert.equal(context.recordedBugRepairs, 2);
  assert.equal(context.sentClaudeCalls, 2);
  assert.equal(context.priorSentClaudeCalls, 2);
  assert.equal(context.currentSentClaudeCalls, 0);
  assert.equal(context.current.sessionId, null);
  assert.equal(context.currentAlreadySent, false);
  assert.equal(context.withinSessionLimits, true);
  assert.equal(context.maySendUnsentCurrentTurn, true);
  assert.deepEqual(
    context.sameRootPreviousRecords.map((item) => item.id),
    ['ui', 'ui-repair-one'],
  );
  assert.deepEqual(
    context.otherRootHistory.map((item) => item.id),
    ['backend', 'backend-repair', 'excluded-feature'],
  );
  assert.ok(
    context.otherRootHistory.every(
      (item) => item.historyScope === 'other-question-session',
    ),
  );
  assert.deepEqual(task, original);
});

test('a third Bug still exceeds the existing two-repair and three-question limits', () => {
  const { task, turn } = fixture();
  Object.assign(turn, sent(turn.id, 'ui', 'native-ui', 'ui-repair-one'));
  const excess = {
    id: 'ui-repair-three',
    questionRootId: 'ui',
    repairOf: turn.id,
    category: 'Bug 修复',
    status: 'queued',
  };
  task.turns.push(excess);
  const context = policySessionContext(task, excess);
  assert.equal(context.currentLogicalTurn, 4);
  assert.equal(context.currentBugRepairOrdinal, 3);
  assert.equal(context.sentClaudeCalls, 3);
  assert.equal(context.withinSessionLimits, false);
  assert.equal(context.maySendUnsentCurrentTurn, false);
  assert.match(context.violations.join(' '), /两轮 Bug.*三条|三条.*两轮 Bug/);
});

test('sent calls consume the exact existing attempt count and are never authorized for duplicate send', () => {
  const { task, turn } = fixture();
  task.turns.find((item) => item.id === 'ui').claudeAttempts = Array(9).fill(
    {},
  );
  let context = policySessionContext(task, turn);
  assert.equal(context.sentClaudeCalls, 10);
  assert.equal(context.withinSessionLimits, false);
  assert.equal(context.maySendUnsentCurrentTurn, false);
  task.turns.find((item) => item.id === 'ui').claudeAttempts = Array(8).fill(
    {},
  );
  Object.assign(turn, sent(turn.id, 'ui', 'native-ui', 'ui-repair-one'));
  context = policySessionContext(task, turn);
  assert.equal(context.sentClaudeCalls, 10);
  assert.equal(context.withinSessionLimits, true);
  assert.equal(context.currentAlreadySent, true);
  assert.equal(context.maySendUnsentCurrentTurn, false);
});

test('excluded or failed questions do not silently release recorded logical or repair quotas', () => {
  const { task, turn } = fixture();
  const prior = task.turns.find((item) => item.id === 'ui-repair-one');
  Object.assign(prior, { excluded: true, status: 'failed' });
  const context = policySessionContext(task, turn);
  assert.equal(context.recordedBugRepairs, 2);
  assert.equal(context.recordedLogicalTurns, 3);
  assert.equal(context.sentClaudeCalls, 2);
  assert.equal(context.sameRootPreviousRecords[1].excluded, true);
});

test('current native identity is derived only from its own root and contradictory identities block new calls', () => {
  const { task, turn } = fixture();
  task.container = { questionId: 'backend', sessionId: 'native-backend' };
  assert.equal(policySessionContext(task, turn).sessionId, 'native-ui');
  task.turns.find((item) => item.id === 'ui-repair-one').sessionId =
    'different-native';
  const context = policySessionContext(task, turn);
  assert.equal(context.sessionId, null);
  assert.equal(context.sessionIdentityConsistent, false);
  assert.equal(context.withinSessionLimits, false);
});

test('a fresh unsent root has no invented native session or inherited call count', () => {
  const { task } = fixture();
  const turn = { id: 'fresh', category: 'Feature 迭代', status: 'queued' };
  task.turns.push(turn);
  const context = policySessionContext(task, turn);
  assert.equal(context.sessionId, null);
  assert.equal(context.currentLogicalTurn, 1);
  assert.equal(context.recordedBugRepairs, 0);
  assert.equal(context.sentClaudeCalls, 0);
  assert.deepEqual(context.sameRootPreviousRecords, []);
});

test('missing and circular root references retain existing questionRoot validation', () => {
  assert.throws(
    () => policySessionContext({ turns: [] }, { id: 'missing' }),
    /缺少当前轮次/,
  );
  const missing = { id: 'repair', repairOf: 'missing' };
  assert.throws(
    () => policySessionContext({ turns: [missing] }, missing),
    /缺少前序轮次/,
  );
  const a = { id: 'a', repairOf: 'b' },
    b = { id: 'b', repairOf: 'a' };
  assert.throws(() => policySessionContext({ turns: [a, b] }, b), /循环/);
  const root = { id: 'root' },
    first = { id: 'one', repairOf: 'root' },
    second = { id: 'two', repairOf: 'one' };
  const context = policySessionContext(
    { turns: [root, first, second] },
    second,
  );
  assert.equal(context.questionRootId, 'root');
  assert.equal(context.currentLogicalTurn, 3);
});
