import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFromAI,
  normalizeHumanDraft,
  humanDraftIssues,
  humanQualityReasons,
  humanIssues,
} from '../lib/human-review.ts';
import { csv } from '../lib/pipeline.ts';
const review = {
  source: 'codex',
  scores: [3, 4, 4, 4, 4],
  descriptions: Array(5).fill('AI description'),
  when: Array(5).fill('执行时'),
  behavior: ['保存错误', '遵守约束', '分步执行', '定位原因', '工具使用'],
  impact: Array(5).fill('实际影响'),
  expected: Array(5).fill('正确做法'),
  evidenceRefs: Array(5).fill('output:1'),
  processFindings: '执行过程记录',
  artifactFindings: '产物检查记录',
  other: '无',
  reviewer: 'Codex CLI',
  attested: false,
};
const turn = {
  id: 'round',
  prompt: '目标',
  output: '结果证据\n第二行',
  review,
  status: 'review',
  sessionId: 'session',
  promptId: 'prompt',
  tracePath: '/trace',
  createdAt: new Date().toISOString(),
};
test('AI seeds evaluation only: name, actual verification and attestation require a human', () => {
  const d = draftFromAI(turn);
  assert.deepEqual(
    d.findings.map((f) => f.score),
    review.scores,
  );
  assert.equal(d.reviewer, '');
  assert.equal(d.verification, '');
  assert.equal(d.attested, false);
  assert.ok(humanDraftIssues(turn, d).length);
  d.reviewer = '测试确认人';
  d.verification = '执行保存操作并刷新，对照错误日志';
  d.attested = true;
  assert.deepEqual(humanDraftIssues(turn, normalizeHumanDraft(d)), []);
  d.findings[0].evidenceRefs = 'output:500';
  assert.match(humanDraftIssues(turn, d).join(''), /不存在/);
  assert.equal(review.attested, false);
});
test('low scores, score disagreements and duplicate boilerplate require explicit resolution', () => {
  const d = draftFromAI(turn);
  assert.deepEqual(humanQualityReasons(turn, d), []);
  d.findings[0].score = 1;
  assert.equal(humanQualityReasons(turn, d).length, 2);
  d.findings.forEach((f) => (f.behavior = '同一句'));
  assert.ok(humanQualityReasons(turn, d).some((x) => x.includes('模板')));
});
test('human export keeps AI original and separates confirmation provenance', () => {
  const d = draftFromAI(turn);
  d.reviewer = '确认人';
  d.verification = '实际核验操作';
  d.attested = true;
  d.findings[0].score = 4;
  const r = {
    ...turn,
    humanReview: {
      draft: d,
      state: 'approved',
      source: 'human-assisted',
      updatedAt: '2026-09-08T00:00:00Z',
      qualityReasons: [],
    },
  };
  const task = {
    title: '来源测试',
    snapshot: 'https://github.com/a/b/commit/' + 'a'.repeat(40),
    harnessVersion: 'v',
    os: 'macOS',
    turns: [r],
  };
  assert.deepEqual(humanIssues(task, r), []);
  const exported = csv([task], 'human');
  assert.match(exported, /人工复核（已有 AI 评估）/);
  assert.match(exported, /非纯人工标注流程/);
  assert.equal(r.review.scores[0], 3);
  r.humanReview.state = 'needs_revision';
  assert.ok(!csv([task], 'human').includes('来源测试'));
});
