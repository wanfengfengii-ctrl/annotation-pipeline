import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scoreDescriptionContext,
  scoreDescriptionVersion,
  scoreDescriptionIssues,
} from '../lib/score-description-context.mjs';
import { scoreInstructions, workflow } from '../lib/workflow.mjs';
import { gatewayContinuationVersion } from '../lib/gateway-continuation.mjs';
import { stageContractDigest } from '../scripts/stage-contract.mjs';

const scored = (id, prompt, description = prompt) => ({
  id,
  prompt,
  status: 'review',
  jobToken: 'private-token-must-not-copy',
  review: {
    scores: [3, 4, 5, 4, 4],
    descriptions: Array.from({ length: 5 }, (_, i) => description + i),
  },
});

test('long copied paragraphs trigger independent review while short factual labels do not', () => {
  const description =
    '本轮保存后的导出内容仍保留旧版本，用户重新打开并检查字段时无法确认最新修改是否已经应用，列表和详情显示了不同状态，需要依据当前源码和实际日志说明这次交付影响的具体范围。';
  const value = {
    scores: [4, 4, 4, 4, 4],
    descriptions: [
      description,
      description,
      '实际返回 504',
      '无',
      '工具已返回',
    ],
  };
  const before = structuredClone(value);
  const issues = scoreDescriptionIssues(value, [
    { turnId: 'old', descriptions: [description] },
  ]);
  assert.ok(issues.some((x) => x.includes('第2维与第1维')));
  assert.ok(issues.some((x) => x.includes('历史记录old')));
  assert.deepEqual(value, before);
  assert.deepEqual(
    scoreDescriptionIssues({ descriptions: Array(5).fill('实际返回 504') }),
    [],
  );
});

test('related older feedback survives recent unrelated turns; current, future and excluded records stay out', () => {
  const related = scored(
    'related',
    '导入工作区后迟到的请求响应覆盖结果',
    'runValidation 的旧响应覆盖新工作区',
  );
  const current = scored('current', '导入工作区后丢弃迟到的请求响应，保留结果');
  const task = {
    jobToken: 'task-secret',
    turns: [
      related,
      ...Array.from({ length: 8 }, (_, i) =>
        scored('unrelated-' + i, '画布节点连接顺序' + i),
      ),
      { ...scored('excluded', current.prompt), excluded: true },
      { ...scored('unfinished', current.prompt), status: 'running' },
      current,
      scored('future', current.prompt),
    ],
  };
  const before = structuredClone(task);
  const history = scoreDescriptionContext(task, current);
  assert.equal(history.length, 4);
  assert.equal(history[0].turnId, 'related');
  for (const id of ['current', 'future', 'excluded', 'unfinished'])
    assert.ok(!history.some((row) => row.turnId === id));
  assert.deepEqual(task, before);
  const prompt = scoreInstructions({ task, turn: current });
  assert.ok(prompt.includes(scoreDescriptionVersion));
  assert.ok(prompt.includes('runValidation 的旧响应覆盖新工作区'));
  assert.ok(!prompt.includes('private-token-must-not-copy'));
  assert.ok(!prompt.includes('task-secret'));
  for (const dimension of workflow.dimensions)
    assert.ok(prompt.includes(dimension.rubric));
});

test('comparison excerpts are bounded, scores are not anchors and current continuation history is excluded', () => {
  const root = scored('root', '当前原题');
  const current = {
    id: 'continuation',
    prompt: '继续',
    continuationOf: 'root',
    gatewayContinuation: {
      version: gatewayContinuationVersion,
      failedTurnId: 'root',
      failedPromptId: 'native-message',
      sessionId: 'session',
      containerId: 'container',
      traceSha256: 'a'.repeat(64),
    },
  };
  const task = {
    turns: [
      scored('large', '原文'.repeat(3000), '实际观察'.repeat(3000)),
      root,
      current,
    ],
  };
  const before = structuredClone(task);
  const history = scoreDescriptionContext(task, current);
  assert.deepEqual(
    history.map((row) => row.turnId),
    ['large'],
  );
  assert.equal(history[0].excerpted, true);
  assert.ok(history[0].prompt.length <= 360);
  assert.ok(history[0].descriptions.every((text) => text.length <= 400));
  assert.equal(history[0].scores, undefined);
  assert.deepEqual(task, before);
  assert.deepEqual(scoreDescriptionContext(task, { id: 'unknown' }), []);
  assert.deepEqual(scoreDescriptionContext(), []);
});

test('changing description guidance invalidates scoring checkpoints while leaving question policy intact', () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'score-description-contract-'),
  );
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    for (const name of ['scripts', 'lib', 'rules'])
      fs.cpSync(path.join(root, name), path.join(dir, name), {
        recursive: true,
      });
    const before = Object.fromEntries(
      ['score', 'delivery', 'policy'].map((stage) => [
        stage,
        stageContractDigest(dir, stage),
      ]),
    );
    fs.appendFileSync(
      path.join(dir, 'lib/score-description-context.mjs'),
      '\n// guidance revision\n',
    );
    assert.notEqual(stageContractDigest(dir, 'score'), before.score);
    assert.notEqual(stageContractDigest(dir, 'delivery'), before.delivery);
    assert.equal(stageContractDigest(dir, 'policy'), before.policy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
