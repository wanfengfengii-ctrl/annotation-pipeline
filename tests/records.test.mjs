import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import {
  recordHeaders,
  recordRow,
  recordFilter,
} from '../lib/record-fields.ts';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';

test('实际工作簿字段完整有序，AI 与实际提交来源分开，Excel 文本不执行公式', () => {
  assert.equal(recordHeaders.length, 30);
  assert.deepEqual(recordHeaders.slice(0, 7), [
    'User Prompt',
    'SessionID',
    'TurnID/PromptID',
    '当前对话轮次排序',
    '初始环境快照',
    '轨迹文件',
    '环境可复现等级',
  ]);
  assert.deepEqual(recordHeaders.slice(23, 27), [
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
    roundNumber: 1,
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
      descriptions: [
        '筛选已经实现。切换状态后仍停在原页码，需要重置页码并补上对应测试。',
        'b',
        'c',
        'd',
        'e',
      ],
      other: '无',
    },
    automation: {
      delivery: { value: { passed: true } },
      bundlePath: '/fixture/bundle',
    },
  };
  const row = recordRow(task, turn, 'ai');
  assert.equal(row.eligible, true);
  assert.equal(row.values.length, 30);
  assert.deepEqual(row.values.slice(24, 27), [
    '',
    '',
    'AI 校验通过（待人工确认）',
  ]);
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
    ).values[25],
    '2026/09/09 00:01:02',
  );
  assert.deepEqual(recordHeaders.slice(-3), ['父记录', '审核备注', '父记录 2']);
  assert.deepEqual(row.values.slice(-3), ['', '', '']);
  const dated = recordRow(
    task,
    { ...turn, receipt: 'actual', submittedAt: '2026-09-08T16:01:02Z' },
    'ai',
  );
  const dateSheet = strFromU8(
    unzipSync(xlsx([dated], 'date'))['xl/worksheets/sheet1.xml'],
  );
  assert.match(dateSheet, /<c r="Z2" s="3"><v>46274\.000717/);
  const zip = unzipSync(xlsx([row], 'fixture-batch'));
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  assert.ok(!sheet.includes('<f>'));
  assert.match(sheet, /t="inlineStr"/);
  assert.ok(sheet.includes(turn.review.descriptions[0]));
  assert.equal(row.values[14], turn.review.descriptions[0]);
  assert.match(sheet, /&lt;&amp;&quot;/);
  assert.match(sheet, /<c r="D2" s="2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<c r="N2" s="2"><v>1<\/v><\/c>/);
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
