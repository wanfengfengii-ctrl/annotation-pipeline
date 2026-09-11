import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginQuestionRevision,
  questionRevisionInstructions,
} from '../lib/question-revision.mjs';
import { assertWritingRevision } from '../lib/writing-style.mjs';
import { questionCacheState } from '../lib/question-cache.mjs';
import { questionRules } from '../lib/question-writing.mjs';

const preparation = {
  value: {
    prompt: '重复题面',
    category: 'Bug 修复',
    difficulty: '中等',
    stack: 'JavaScript',
    acceptance: ['保留三次 HTTP 500 失败记录'],
  },
};
const audit = {
  engine: 'codex-cli',
  tracePath: '/task/attempt-1.policy.events.jsonl',
  value: {
    allowed: false,
    questionCompliant: false,
    wordingDuplicatePairs: ['同一结果重复两次'],
  },
};
test('unsent duplicate wording receives one revision and preserves rejection and non-prompt fields', () => {
  const cached = {
    prepare: structuredClone(preparation),
    policy: structuredClone(audit),
    checkpoints: { policy: { old: true }, score: { keep: true } },
  };
  assert.equal(
    beginQuestionRevision(cached, { audit, preserveQuestion: false }),
    true,
  );
  assert.deepEqual(cached.questionRevision.preparation, preparation);
  assert.deepEqual(cached.questionRevision.rejectedAudit, audit);
  assert.equal(cached.prepare, undefined);
  assert.equal(cached.checkpoints.policy, undefined);
  assert.deepEqual(cached.checkpoints.score, { keep: true });
  assert.match(
    questionRevisionInstructions(cached.questionRevision),
    /再次完整审核/,
  );
  assert.match(
    questionRevisionInstructions(cached.questionRevision),
    /只返回 \{"prompt"/,
  );
  cached.prepare = structuredClone(preparation);
  assert.equal(
    beginQuestionRevision(cached, { audit, preserveQuestion: false }),
    false,
  );
  assert.doesNotThrow(() =>
    assertWritingRevision('prepare', preparation.value, {
      ...preparation.value,
      prompt: '合并后的题面',
    }),
  );
  assert.throws(
    () =>
      assertWritingRevision('prepare', preparation.value, {
        ...preparation.value,
        acceptance: ['删除三次失败条件'],
      }),
    /不得改动 prepare.acceptance/,
  );
});
test('sent or uncertain Terminal prompts and business-only rejections are never rewritten', () => {
  for (const [cached, preserveQuestion] of [
    [{ prepare: structuredClone(preparation), claude: {} }, false],
    [{ prepare: structuredClone(preparation) }, true],
  ]) {
    const before = structuredClone(cached);
    assert.equal(
      beginQuestionRevision(cached, { audit, preserveQuestion }),
      false,
    );
    assert.deepEqual(cached, before);
  }
  const cached = { prepare: structuredClone(preparation) };
  const pending = { turnId: 'current', phase: 'sent' };
  assert.equal(
    beginQuestionRevision(cached, {
      audit,
      ...questionCacheState(cached, pending, 'current'),
    }),
    false,
  );
  assert.equal(
    beginQuestionRevision(cached, {
      audit: { ...audit, value: { ...audit.value, wordingDuplicatePairs: [] } },
      preserveQuestion: false,
    }),
    false,
  );
});

test('an unsent language-only rejection gets one revision without changing its scope or audit', () => {
  const languageAudit = {
    ...audit,
    value: {
      ...audit.value,
      duplicateTaskIds: [],
      wordingDuplicatePairs: [],
      questionChecks: Object.keys(questionRules.criteria).map(
        (id) =>
          `${id}：${id === 'language' ? '不通过，先说异常现象' : '通过，依据完整'}`,
      ),
    },
  };
  const cached = { prepare: structuredClone(preparation) };
  assert.equal(
    beginQuestionRevision(cached, {
      audit: languageAudit,
      preserveQuestion: false,
    }),
    true,
  );
  assert.equal(cached.questionRevision.issue, 'language');
  assert.match(
    questionRevisionInstructions(cached.questionRevision),
    /只返回 \{"prompt"/,
  );
  assert.deepEqual(cached.questionRevision.preparation, preparation);
  assert.deepEqual(cached.questionRevision.rejectedAudit, languageAudit);
  cached.prepare = structuredClone(preparation);
  assert.equal(
    beginQuestionRevision(cached, {
      audit: languageAudit,
      preserveQuestion: false,
    }),
    false,
  );
  for (const change of [
    'missing-check',
    'business-failure',
    'duplicate-task',
    'already-sent',
    'unknown-outcome',
  ]) {
    const candidate = { prepare: structuredClone(preparation) };
    const rejected = structuredClone(languageAudit);
    if (change === 'missing-check') rejected.value.questionChecks.pop();
    if (change === 'business-failure')
      rejected.value.questionChecks[0] = 'audience：不通过，范围错误';
    if (change === 'duplicate-task')
      rejected.value.duplicateTaskIds = ['existing'];
    if (change === 'already-sent') candidate.claude = { success: true };
    if (change === 'unknown-outcome')
      rejected.value.questionChecks[0] = 'audience：尚待核验';
    const before = structuredClone(candidate);
    assert.equal(
      beginQuestionRevision(candidate, {
        audit: rejected,
        preserveQuestion: false,
      }),
      false,
      change,
    );
    assert.deepEqual(candidate, before);
  }
});
