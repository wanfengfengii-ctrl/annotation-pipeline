import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginQuestionRevision,
  questionRevisionInstructions,
} from '../lib/question-revision.mjs';
import { assertWritingRevision } from '../lib/writing-style.mjs';
import { questionCacheState } from '../lib/question-cache.mjs';

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
