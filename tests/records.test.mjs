import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import {
  recordHeaders,
  recordRow,
  recordFilter,
  recordCategory,
  recordOS,
  recordStack,
  recordRound,
} from '../lib/record-fields.ts';
import { exportScope, recordSelection } from '../lib/record-selection.ts';
import { xlsx, recordsCsv } from '../lib/xlsx.ts';
import { formatQuestionText } from '../lib/question-text.mjs';

test('项目筛选独立于导出字段，题面只规范显示副本', () => {
  assert.equal(recordFilter({ projectId: 'task-1' }).projectId, 'task-1');
  assert.deepEqual(recordFilter({ projectId: '' }), recordFilter({}));
  assert.throws(() => recordFilter({ projectId: "' OR 1=1 --" }), /筛选/);
  assert.ok(!recordHeaders.includes('项目名称'));
  const prompt = ' `校样台` \r\n\r\n  对比 `A` 与 `B`。\n \n 保留图片。\n';
  const turn = {
    id: 'round',
    prompt,
    category: '0-1 代码生成',
    difficulty: '困难',
  };
  const row = recordRow({ id: 'task', title: '校样台' }, turn, 'ai');
  assert.equal(row.values[0], '校样台\n对比 A 与 B。\n保留图片。');
  assert.equal(turn.prompt, prompt);
  assert.equal(formatQuestionText(row.values[0]), row.values[0]);
  const sheet = strFromU8(
    unzipSync(xlsx([row], 'formatted'))['xl/worksheets/sheet1.xml'],
  );
  assert.ok(!sheet.includes('`') && !sheet.includes('\n\n'));
  assert.ok(!sheet.includes('项目名称'));
  assert.ok(!recordsCsv([row]).includes('`'));
});

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
    tracePath: '/fixture/session.jsonl',
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
  assert.equal(
    recordRow(task, { ...turn, reproducibility: '有外部依赖，未容器化' }, 'ai')
      .values[6],
    '有外部依赖，未容器化',
  );
  assert.equal(row.values[6], '无外部依赖');
  assert.equal(row.values[5], 'session.jsonl');
  assert.equal(row.originalFields.tracePath, '/fixture/session.jsonl');
  assert.equal(row.values[9], 'MacOS/Linux');
  assert.equal(row.values[10], '0-1代码生成');
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
  assert.match(dateSheet, /<c r="AA2" s="3"><v>46274\.000717/);
  const zip = unzipSync(xlsx([row], 'fixture-batch'));
  const sheet = strFromU8(zip['xl/worksheets/sheet1.xml']);
  assert.ok(!sheet.includes('<f>'));
  assert.match(sheet, /t="inlineStr"/);
  assert.ok(sheet.includes(turn.review.descriptions[0]));
  assert.equal(row.values[14], turn.review.descriptions[0]);
  assert.match(sheet, /&lt;&amp;&quot;/);
  assert.match(sheet, /<c r="A2" s="2"><v>1<\/v><\/c>/);
  assert.match(
    sheet,
    /<c r="E2" s="2" t="inlineStr"><is><t xml:space="preserve">第一轮<\/t>/,
  );
  assert.match(sheet, /<c r="O2" s="2"><v>1<\/v><\/c>/);
  assert.match(sheet, /<hyperlink ref="F2" r:id="rId1"/);
  assert.match(
    strFromU8(zip['xl/worksheets/_rels/sheet1.xml.rels']),
    /Target="https:\/\/github.com\/a\/b\/commit\/a{40}"/,
  );
  assert.match(recordsCsv([row]), /^\ufeff"序号","User Prompt","SessionID"/);
  assert.match(strFromU8(zip['xl/worksheets/sheet2.xml']), /未经人工确认/);
  assert.match(recordsCsv([row]), /'=1\+1/);
  assert.throws(
    () => xlsx([{ ...row, values: ['x'.repeat(32768)] }], 'fixture'),
    /32767/,
  );
});

test('样表字段统一显示，真实容器快照不替换为参考仓库，人工字段不改写', () => {
  assert.equal(recordCategory('Feature 迭代'), 'feature迭代');
  assert.equal(recordCategory('Bug 修复'), 'Bug修复');
  assert.equal(recordCategory('代码理解'), '代码理解');
  assert.equal(recordOS('Linux 6.12.69-linuxkit'), 'MacOS/Linux');
  assert.equal(recordOS('Windows 11'), 'Windows');
  assert.equal(
    recordStack('Python 3, SQLite， FastAPI; React\nVite'),
    'Python 3、SQLite、FastAPI、React、Vite',
  );
  const t = {
    id: 't',
    title: 'fixture',
    snapshot: 'https://github.com/reference/repo/commit/' + 'a'.repeat(40),
  };
  const r = {
    id: 'r',
    prompt: 'fixture',
    category: 'Bug 修复',
    difficulty: '困难',
    container: {
      snapshot: 'docker://actual@sha256:' + 'b'.repeat(64),
      scaffoldSnapshot: {
        manifestPath: '/actual/manifest.json',
        sha256: 'c'.repeat(64),
      },
    },
    recordMetadata: {
      parentRecord: 'parent',
      auditNote: 'keep',
      parentRecord2: 'parent2',
    },
    review: {
      source: 'codex',
      scores: [3, 3, 3, 3, 3],
      reviewer: 'Codex',
      descriptions: Array(5).fill('原始评价'),
      other: '无',
    },
  };
  const row = recordRow(t, r, 'ai');
  assert.equal(row.values[4], '');
  assert.equal(row.eligible, false);
  const actualURL =
    'https://github.com/fixture/initial/commit/' + 'b'.repeat(40);
  t.initialCodeSnapshots = {
    r: { url: actualURL, publicationMode: 'backfill' },
  };
  assert.equal(recordRow(t, r, 'ai').values[4], actualURL);
  assert.equal(
    recordRow(t, { ...r, id: 'repair', questionRootId: 'r' }, 'ai').values[4],
    actualURL,
  );
  assert.equal(
    recordRow(
      t,
      { ...r, id: 'new-question', questionRootId: 'new-question' },
      'ai',
    ).values[4],
    '',
  );
  assert.match(
    recordRow(t, r, 'ai').originalFields.initialCodeNote,
    /执行后补发/,
  );
  assert.match(
    row.originalFields.snapshot,
    /骨架快照：\/actual\/manifest.json#sha256:/,
  );
  assert.deepEqual(row.values.slice(23), [
    '无',
    '',
    '',
    '待 AI 校验',
    'parent',
    'keep',
    'parent2',
  ]);
  assert.deepEqual(r.review.descriptions, Array(5).fill('原始评价'));
  const zip = unzipSync(xlsx([row], 'container'));
  assert.equal(zip['xl/worksheets/_rels/sheet1.xml.rels'], undefined);
  assert.match(
    strFromU8(zip['xl/worksheets/sheet2.xml']),
    /\/actual\/manifest.json/,
  );
});

test('轮次使用中文顺序，语言框架去除业务说明并保留库名与版本', () => {
  assert.deepEqual([1, 2, 3, 10].map(recordRound), [
    '第一轮',
    '第二轮',
    '第三轮',
    '第十轮',
  ]);
  assert.equal(recordRound(''), '');
  assert.equal(
    recordStack(
      'Python 3 标准库、SQLite（sqlite3）、HTTP 服务与客户端、unittest、多进程集成测试',
    ),
    'Python 3、SQLite（sqlite3）、unittest',
  );
  assert.equal(
    recordStack(
      'Python 3、SQLite、Python 标准库 urllib.request/http.server、unittest；现有 HTML 仅为空骨架，未接入服务路由。',
    ),
    'Python 3、SQLite、urllib.request/http.server、unittest',
  );
  assert.equal(
    recordStack(
      'Go 1.23.12、标准库 net/http、HTML、CSS、原生 JavaScript、WebSocket',
    ),
    'Go 1.23.12、标准库 net/http、HTML、CSS、原生 JavaScript、WebSocket',
  );
});

test('选中范围必须明确且标识稳定、去除顺序差异，拒绝空选、重复及过量记录', () => {
  assert.equal(exportScope('selected'), 'selected');
  assert.throws(() => exportScope('typo'), /范围/);
  const a = { taskId: 'task', turnId: 'a' },
    b = { taskId: 'task', turnId: 'b' };
  assert.deepEqual(recordSelection([b, a]), recordSelection([a, b]));
  for (const value of [
    undefined,
    [],
    [null],
    [a, a],
    [{ taskId: 't', turnId: "' OR 1=1" }],
    Array(1001).fill(a),
  ])
    assert.throws(() => recordSelection(value));
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
