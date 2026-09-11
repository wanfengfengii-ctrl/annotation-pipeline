import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreInstructions, workflow } from '../lib/workflow.mjs';

test('scoring carries every dimension rubric and requires reviewable grade reasons', () => {
  const prompt = scoreInstructions();
  assert.ok(prompt.includes(workflow.version));
  for (const level of workflow.scoreLevels) assert.ok(prompt.includes(level));
  for (const dimension of workflow.dimensions)
    assert.ok(prompt.includes(`${dimension.name}：${dimension.rubric}`));
  assert.match(
    prompt,
    /processFindings 按五维.*实际证据.*所选档位.*相邻高档.*相邻低档/,
  );
  assert.match(prompt, /1 分或 5 分只比较存在的相邻档/);
  assert.match(prompt, /不能为沿用旧分数而凑理由.*AI 核验后自行决定/);
  assert.match(prompt, /processFindings 标明本次采用的评分规则版本/);
  assert.match(prompt, /不新增 schema 未定义的分档字段/);
  assert.match(
    prompt,
    /descriptions 每项只用通俗的一段话说明本维真实表现及影响/,
  );
  assert.match(prompt, /所有打分后的 descriptions 必须真实、通俗易懂/);
  assert.match(prompt, /没有实际执行的操作不能写成试过、验证通过或已经可用/);
  assert.match(prompt, /不因公开点评没有分档分析或行号而判为缺少证据/);
  assert.match(
    prompt,
    /evidenceRefs 每维提供 1 至 8 个实际存在的文件路径:行号/,
  );
  assert.doesNotMatch(
    prompt,
    /选档理由写入各维 descriptions|保留真实的相对文件路径或日志行号|再写对应档位/,
  );
});

test('scoring separates immutable pre-execution expectations from verified latest results', () => {
  const prompt = scoreInstructions();
  assert.match(prompt, /artifactFindings 按本轮最新且已验真.*报告及原日志/);
  assert.match(prompt, /实际运行数、通过数、失败数和跳过数/);
  assert.match(prompt, /评分阶段仅只读、未重新运行测试不等于独立验收没有运行/);
  assert.match(prompt, /expected 是执行前预期.*本阶段尚未运行属于当时状态/);
  assert.match(
    prompt,
    /执行后的结论按已验真的 outcome、observed、退出码及原日志判断/,
  );
  assert.match(prompt, /不能改写原计划、报告、日志或历史评分及拒审记录/);
  assert.match(
    prompt,
    /缺少真实执行证据仍写未验证.*不能仅凭 outcome 名称或模型自报断言通过/,
  );
  assert.match(
    prompt,
    /临时副本按原 manifest 安装依赖后测试通过.*该条件下的实际测试结果/,
  );
  assert.match(
    prompt,
    /保留原 npm ci 失败和清单与锁文件错配.*不能声称干净安装通过/,
  );
  assert.match(prompt, /独立验收的操作不得归为被测模型的行为/);
  assert.match(prompt, /后续独立验收未完成，不等于原作业漏做或原题功能不可用/);
  assert.match(prompt, /未记录实际值的断言失败，不能单独作为产品缺陷/);
  assert.match(prompt, /不否定原作业已有的通过证据/);
  assert.match(
    prompt,
    /缺少实际观察时保留证据缺口并补验，不编造缺陷、不预设满分/,
  );
  assert.match(prompt, /交付校验提出的建议分数只是复核线索，不直接照抄/);
});
