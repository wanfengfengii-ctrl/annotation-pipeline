import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sanitizeSensitiveText } from '../lib/sensitive-content.mjs';

export const sqliteScanVersion = '2026-09-10.sqlite1';
const header = Buffer.from('SQLite format 3\0');
export const isSqlite = (bytes) =>
  Buffer.from(bytes).subarray(0, 16).equals(header);
const inspect = String.raw`
import sqlite3, pathlib, sys, json
p=pathlib.Path(sys.argv[1]).resolve()
c=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1', uri=True)
if hasattr(c,'enable_load_extension'): c.enable_load_extension(False)
c.execute('PRAGMA query_only=ON')
c.execute('PRAGMA trusted_schema=OFF')
if c.execute('PRAGMA encoding').fetchone()[0]!='UTF-8': raise ValueError('encoding')
steps=[0]
def budget():
 steps[0]+=1
 return steps[0]>10000
c.set_progress_handler(budget,1000)
if c.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]: raise ValueError('integrity')
schema=c.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').fetchall()
if len(schema)>1000: raise ValueError('schema limit')
if any('CREATE VIRTUAL TABLE' in (x[3] or '').upper() for x in schema): raise ValueError('virtual table')
tables=[]; row_count=0; text_bytes=0
for typ,name,_,sql in schema:
 if typ!='table': continue
 quoted='"'+name.replace('"','""')+'"'
 info=c.execute('PRAGMA table_xinfo('+quoted+')').fetchall()
 if len(info)>256 or any(x[6] for x in info): raise ValueError('generated or wide table')
 cursor=c.execute('SELECT * FROM '+quoted)
 columns=[d[0] for d in cursor.description]; rows=[]
 for row in cursor:
  row_count+=1
  if row_count>50000: raise ValueError('row limit')
  values={}
  for key,value in zip(columns,row):
   if isinstance(value,bytes):
    value=value.decode('utf-8','strict')
    if '\x00' in value: raise ValueError('binary blob')
   if isinstance(value,str) and len(value.encode())>1024*1024: raise ValueError('cell limit')
   values[key]=value
  text_bytes+=len(json.dumps(values,ensure_ascii=False).encode())
  if text_bytes>8*1024*1024: raise ValueError('text limit')
  rows.append(values)
 tables.append({'name':name,'rows':rows})
print(json.dumps({'schema':schema,'tables':tables,'rows':row_count},ensure_ascii=False))
`;

// Files stay byte-for-byte intact. Any unreadable, over-budget or suspicious
// content requires review; this scanner never rewrites a database to clear it.
export function scanSqliteContent(input, { knownSecrets = [] } = {}) {
  const bytes = Buffer.from(input);
  const base = {
    version: sqliteScanVersion,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  if (!isSqlite(bytes) || bytes.length > 16 * 1024 * 1024)
    return {
      ...base,
      status: 'needs_review',
      reason: 'unsupported-sqlite-size-or-header',
    };
  const dir = mkdtempSync(path.join(tmpdir(), 'annotation-sqlite-scan-'));
  try {
    const file = path.join(dir, 'source.sqlite3');
    writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    const data = JSON.parse(
      execFileSync('python3', ['-c', inspect, file], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    const kinds = new Set();
    // Scan column/value pairs as well as raw pages, including free pages that
    // can retain deleted values. Known secrets are checked in each encoding.
    const contexts = [];
    for (const table of data.tables)
      for (const row of table.rows) {
        contexts.push(JSON.stringify(row));
        for (const value of Object.values(row))
          if (typeof value === 'string') contexts.push(value);
        const key = row.key ?? row.name ?? row.config_key;
        if (typeof key === 'string' && 'value' in row)
          contexts.push(JSON.stringify({ [key]: row.value }));
      }
    for (const text of [
      JSON.stringify(data),
      ...contexts,
      bytes.toString('utf8'),
      bytes.toString('utf16le'),
      bytes.toString('latin1'),
    ])
      for (const finding of sanitizeSensitiveText(text, { knownSecrets })
        .findings)
        kinds.add(finding.kind);
    return {
      ...base,
      status: kinds.size ? 'needs_review' : 'passed',
      ...(kinds.size
        ? {
            reason: 'sensitive-sqlite-content',
            findings: [...kinds].sort((a, b) => a.localeCompare(b)),
          }
        : {}),
      tables: data.tables.length,
      rows: data.rows,
    };
  } catch {
    // Python diagnostics may contain cell values: never expose them.
    return {
      ...base,
      status: 'needs_review',
      reason: 'unreadable-or-unsupported-sqlite',
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
