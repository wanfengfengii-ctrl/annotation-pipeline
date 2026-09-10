import { zipSync, strToU8 } from 'fflate';
import {
  recordHeaders,
  snapshotLink,
  type RecordRow,
} from './record-fields.ts';
const xml = (v: unknown) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const col = (n: number) => {
  let s = '';
  for (n++; n; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const oldHeaders = recordHeaders.filter(
  (h) => !['当前对话轮次排序', '父记录', '审核备注', '父记录 2'].includes(h),
);
function headersFor(rows: RecordRow[]) {
  // Saved batches keep their original schema; only newly generated rows add serials.
  const numbered = rows.length > 0 && rows.every((r) => r.formatVersion === 2);
  if (rows.some((r) => r.formatVersion === 2) && !numbered)
    throw Error('导出字段结构不一致，请重新生成批次');
  if (rows.length && rows.every((r) => r.values.length === 26))
    return oldHeaders;
  if (rows.some((r) => r.values.length !== 30))
    throw Error('导出字段结构不一致，请重新生成批次');
  return numbered ? ['序号', ...recordHeaders] : recordHeaders;
}
const exportValues = (r: RecordRow, i: number) => {
  const values = [...r.values];
  if (r.exportPurpose === 'review') {
    const headers = values.length === 26 ? oldHeaders : recordHeaders;
    const quality = headers.indexOf('质检结果');
    values[quality] =
      `复核副本（非正式交付） · ${values[quality] || '待核验'}${r.exportIssues?.length ? '；正式交付待处理：' + r.exportIssues.join('；') : ''}`;
  }
  return r.formatVersion === 2 ? [i + 1, ...values] : values;
};
function excelDate(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return null;
  const time = Date.parse(value.replaceAll('/', '-').replace(' ', 'T') + 'Z');
  return Number.isFinite(time) ? time / 86400000 + 25569 : null;
}
function cellXml(
  v: string | number,
  row: number,
  column: number,
  headers: readonly string[],
) {
  const ref = col(column) + String(row + 1);
  const date = row > 0 && headers[column] === '提交时间' ? excelDate(v) : null;
  if (date !== null) return `<c r="${ref}" s="3"><v>${date}</v></c>`;
  return typeof v === 'number'
    ? `<c r="${ref}" s="2"><v>${v}</v></c>`
    : `<c r="${ref}" s="${row === 0 ? 1 : 2}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
}
export function xlsx(
  rows: RecordRow[],
  batchId: string,
  safety?: { version: string; findings: number },
) {
  if (rows.some((row) => row.values.some((v) => String(v).length > 32767)))
    throw Error(
      '有字段超过 Excel 单元格 32767 字限制，请改用 CSV 导出完整内容',
    );
  const data = [Array.from(headersFor(rows)), ...rows.map(exportValues)];
  if (rows.length > 1000 || JSON.stringify(data).length > 16000000)
    throw Error('一次导出最多 1000 条或 16MB 文本，请缩小筛选范围或按页导出');
  if (data.some((row) => row.some((v) => String(v).length > 32767)))
    throw Error(
      '有字段超过 Excel 单元格 32767 字限制，请改用 CSV 导出完整内容',
    );
  // Use OOXML links, never executable HYPERLINK formulas copied from a template.
  const snapshotColumn = data[0].indexOf('初始环境快照');
  const links = data.slice(1).flatMap((r, i) => {
    const url = String(r[snapshotColumn]);
    return snapshotLink(url)
      ? [{ ref: col(snapshotColumn) + (i + 2), url }]
      : [];
  });
  const sheet = (grid: (string | number)[][], withLinks = false) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${grid[0].map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${grid[0][i] === '序号' ? 8 : grid[0][i] === 'User Prompt' ? 60 : String(grid[0][i]).includes('描述') || grid[0][i] === '审核备注' ? 48 : 24}" customWidth="1"/>`).join('')}</cols><sheetData>${grid.map((row, i) => `<row r="${i + 1}"${i === 0 ? ' ht="30" customHeight="1"' : ''}>${row.map((v, j) => cellXml(v, i, j, grid[0].map(String))).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${col(grid[0].length - 1)}${grid.length}"/>${withLinks && links.length ? '<hyperlinks>' + links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('') + '</hyperlinks>' : ''}</worksheet>`;
  const notes: (string | number)[][] = [
    [
      '导出批次',
      '任务',
      '轮次',
      '评分来源',
      '导出前次数',
      '说明',
      '原始快照及代码清单',
      '原始轨迹路径',
      '原始操作系统',
      '原始语言/框架',
      '初始代码快照说明',
      '导出用途',
      '正式交付待处理项',
    ],
    ...rows.map((r) => [
      batchId,
      r.taskId,
      r.turnId,
      r.provenance,
      r.exportCount,
      '导出次数表示成功生成表格的次数，不代表对外提交；轨迹文件名不代表已上传附件。' +
        (safety
          ? ` 当前下载为敏感信息处理副本，规则 ${safety.version}，处理 ${safety.findings} 处；内部原始记录及批次快照保留。`
          : ''),
      r.originalFields?.snapshot || '',
      r.originalFields?.tracePath || '',
      r.originalFields?.os || '',
      r.originalFields?.stack || '',
      r.originalFields?.initialCodeNote || '',
      r.exportPurpose === 'review' ? '复核副本（非正式交付）' : '正式交付',
      (r.exportIssues || []).join('；'),
    ]),
  ];
  const files: Record<string, Uint8Array> = {};
  const add = (p: string, s: string) => (files[p] = strToU8(s));
  add(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  add(
    'xl/workbook.xml',
    `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${rows.some((r) => r.exportPurpose === 'review') ? '标注数据（复核副本）' : '标注数据'}" sheetId="1" r:id="rId1"/><sheet name="来源与导出记录" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  add(
    'xl/styles.xml',
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF244B81"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  add('xl/worksheets/sheet1.xml', sheet(data, true));
  if (links.length)
    add(
      'xl/worksheets/_rels/sheet1.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l.url)}" TargetMode="External"/>`).join('')}</Relationships>`,
    );
  add('xl/worksheets/sheet2.xml', sheet(notes));
  return zipSync(files, { level: 6 });
}
export function recordsCsv(rows: RecordRow[]) {
  const cell = (v: unknown) =>
    '"' +
    String(v ?? '')
      .replace(/^[=+@\-\t\r]/, (m) => "'" + m)
      .replaceAll('"', '""') +
    '"';
  return (
    '\ufeff' +
    [headersFor(rows), ...rows.map(exportValues)]
      .map((r) => r.map(cell).join(','))
      .join('\r\n')
  );
}
