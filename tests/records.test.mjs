import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import {
  recordHeaders,
  recordRow,
  recordFilter,
} from '../lib/record-fields.ts';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';

test('截图字段完整有序，AI 与实际提交来源分开，Excel 文本不执行公式', () => {
  assert.equal(recordHeaders.length, 26);
  assert.deepEqual(recordHeaders.slice(0, 6), [
    'User Prompt',
    'SessionID',
    'TurnID/PromptID',
    '初始环境快照',
    '轨迹文件',
    '环境可复现等级',
  ]);
  assert.deepEqual(recordHeaders.slice(-4), [
    '其他问题',
    '提交人',
    '提交时间',
    '质检结果',
  ]);
  const task = {
    id: 'task',
    title: 'fixture',
    snapshot: 'https://github.com/a/b/commit/' + 'a'.repeat(40),
    harnessVersion: '2.1',
    os: 'macOS',
    reproducibility: '无外部依赖',
    stack: 'TS',
  };
  const turn = {
    id: 'round',
    prompt: '=1+1\n中文<&"',
    sessionId: 'session',
    promptId: 'prompt',
    tracePath: '/fixture',
    category: '0-1 代码生成',
    difficulty: '困难',
    status: 'review',
    review: {
      source: 'codex',
      reviewer: 'Codex',
      scores: [1, 2, 3, 4, 5],
      descriptions: ['a', 'b', 'c', 'd', 'e'],
      other: '无',
    },
    automation: {
      delivery: { value: { passed: true } },
      bundlePath: '/fixture/bundle',
    },
  };
  const row = recordRow(task, turn, 'ai');
  assert.equal(row.eligible, true);
  assert.equal(row.values.length, 26);
  assert.deepEqual(row.values.slice(23), ['', '', 'AI 校验通过（待人工确认）']);
  assert.equal(
    recordRow(
      task,
      {
        ...turn,
        receipt: 'actual',
        submitter: '实际提交者',
        submittedAt: '2026-09-08T16:01:02Z',
      },
      'ai',
    ).values[24],
    '2026/09/09 00:01:02',
  );
  const zip = unzipSync(xlsx([row], 'fixture-batch'));
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  assert.ok(!sheet.includes('<f>'));
  assert.match(sheet, /t="inlineStr"/);
  assert.match(sheet, /&lt;&amp;&quot;/);
  assert.match(sheet, /<c r="M2" s="2"><v>1<\/v><\/c>/);
  assert.match(strFromU8(zip['xl/worksheets/sheet2.xml']), /未经人工确认/);
  assert.match(recordsCsv([row]), /'=1\+1/);
  assert.throws(
    () => xlsx([{ ...row, values: ['x'.repeat(32768)] }], 'fixture'),
    /32767/,
  );
});

test('分页和次数筛选校验', () => {
  assert.equal(recordFilter({}).pageSize, 20);
  assert.equal(
    recordFilter({ exports: 'exact', count: '2', page: '3', pageSize: '10' })
      .count,
    2,
  );
  for (const f of [
    { page: 0 },
    { pageSize: 999 },
    { count: -1 },
    { source: 'fake' },
    { exports: 'bad' },
    { query: 'a'.repeat(301) },
  ])
    assert.throws(() => recordFilter(f));
});
