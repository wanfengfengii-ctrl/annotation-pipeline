import {
  sanitizeSensitiveText,
  sensitiveContentVersion,
} from './sensitive-content.mjs';

function report() {
  return {
    version: sensitiveContentVersion,
    originalsPreserved: true,
    redactedTextValues: 0,
    findings: 0,
  };
}
export function sanitizeExportRows(rows, options = {}) {
  const safety = report();
  const copy = (value) => {
    if (typeof value === 'string') {
      const result = sanitizeSensitiveText(value, options);
      safety.findings += result.findings.length;
      safety.redactedTextValues += Number(result.changed);
      return result.text;
    }
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, copy(item)]),
      );
    return value;
  };
  return { rows: copy(rows), safety };
}

// Our CSV serializers quote every cell. Decode one cell at a time so a
// credential's surrounding CSV escapes are never mistaken for its value.
export function sanitizeExportCsv(csv, options = {}) {
  const safety = report();
  let output = '',
    cursor = csv.startsWith('\ufeff') ? 1 : 0;
  if (cursor) output = '\ufeff';
  while (cursor < csv.length) {
    if (csv[cursor] !== '"') throw Error('导出 CSV 单元格结构无效');
    cursor++;
    let value = '',
      closed = false;
    while (cursor < csv.length) {
      const char = csv[cursor++];
      if (char !== '"') value += char;
      else if (csv[cursor] === '"') {
        value += '"';
        cursor++;
      } else {
        closed = true;
        break;
      }
    }
    if (!closed) throw Error('导出 CSV 引号未闭合');
    const result = sanitizeSensitiveText(value, options);
    safety.findings += result.findings.length;
    safety.redactedTextValues += Number(result.changed);
    output += '"' + result.text.replaceAll('"', '""') + '"';
    if (csv[cursor] === ',') output += csv[cursor++];
    else if (csv.slice(cursor, cursor + 2) === '\r\n') {
      output += '\r\n';
      cursor += 2;
    } else if (cursor !== csv.length) throw Error('导出 CSV 分隔符无效');
  }
  return { text: output, safety };
}

export function exportSafetyHeaders(safety) {
  return {
    'X-Export-Safety-Version': safety.version,
    'X-Export-Redactions': String(safety.findings),
    'X-Export-Originals-Preserved': 'true',
  };
}
