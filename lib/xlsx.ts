import { zipSync, strToU8 } from 'fflate';
import { recordHeaders, type RecordRow } from './record-fields.ts';
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
  if (rows.length && rows.every((r) => r.values.length === 26))
    return oldHeaders;
  if (rows.some((r) => r.values.length !== 30))
    throw Error('导出字段结构不一致，请重新生成批次');
  return recordHeaders;
}
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
export function xlsx(rows: RecordRow[], batchId: string) {
  if (rows.some((row) => row.values.some((v) => String(v).length > 32767)))
    throw Error(
      '有字段超过 Excel 单元格 32767 字限制，请改用 CSV 导出完整内容',
    );
  const data = [Array.from(headersFor(rows)), ...rows.map((r) => r.values)];
  if (rows.length > 1000 || JSON.stringify(data).length > 16000000)
    throw Error('一次导出最多 1000 条或 16MB 文本，请缩小筛选范围或按页导出');
  if (data.some((row) => row.some((v) => String(v).length > 32767)))
    throw Error(
      '有字段超过 Excel 单元格 32767 字限制，请改用 CSV 导出完整内容',
    );
  const sheet = (grid: (string | number)[][]) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${grid[0].map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 60 : String(grid[0][i]).includes('描述') || grid[0][i] === '审核备注' ? 48 : 24}" customWidth="1"/>`).join('')}</cols><sheetData>${grid.map((row, i) => `<row r="${i + 1}"${i === 0 ? ' ht="30" customHeight="1"' : ''}>${row.map((v, j) => cellXml(v, i, j, grid[0].map(String))).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${col(grid[0].length - 1)}${grid.length}"/></worksheet>`;
  const notes: (string | number)[][] = [
    ['导出批次', '任务', '轮次', '评分来源', '导出前次数', '说明'],
    ...rows.map((r) => [
      batchId,
      r.taskId,
      r.turnId,
      r.provenance,
      r.exportCount,
      '导出次数表示成功生成表格的次数，不代表对外提交；本机轨迹路径不是已上传附件。',
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
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="标注数据" sheetId="1" r:id="rId1"/><sheet name="来源与导出记录" sheetId="2" r:id="rId2"/></sheets></workbook>',
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  );
  add(
    'xl/styles.xml',
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF244B81"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  );
  add('xl/worksheets/sheet1.xml', sheet(data));
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
    [headersFor(rows), ...rows.map((r) => r.values)]
      .map((r) => r.map(cell).join(','))
      .join('\r\n')
  );
}
