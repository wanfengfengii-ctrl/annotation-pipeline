import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  readdirSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Recovery backups also contain .result.json files. Only the canonical
// task/turn spool belongs to the runner; replaying a backup uses stale tokens.
export function recoveryFiles(workRoot, kind) {
  if (!['result', 'job'].includes(kind)) throw Error('恢复文件类型无效');
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const taskPattern = new RegExp('^' + uuid + '$');
  const filePattern = new RegExp('^' + uuid + '\\.' + kind + '\\.json$');
  const files = [];
  for (const name of readdirSync(workRoot)) {
    const dir = path.join(workRoot, name);
    if (!taskPattern.test(name) || !lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (filePattern.test(name) && lstatSync(file).isFile()) files.push(file);
    }
  }
  return files;
}
export function identity(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,comm='], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}
export function acquireLock(lock) {
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const owner = readFileSync(lock, 'utf8').trim();
  if (!/^\d+$/.test(owner) || identity(Number(owner)))
    throw Error('执行器锁仍被使用，请先停止旧执行器');
  if (readFileSync(lock, 'utf8').trim() !== owner)
    throw Error('执行器锁已发生变化');
  unlinkSync(lock);
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}
export function journalChild(journal, p) {
  if (!p?.pid) return;
  const data = JSON.parse(readFileSync(journal, 'utf8'));
  data.children ??= [];
  data.children.push({ pid: p.pid, identity: identity(p.pid) });
  writeFileSync(journal, JSON.stringify(data), { mode: 0o600 });
}
export function livingChildren(journal) {
  return (journal.children || []).filter(
    (c) => c.identity && identity(c.pid) === c.identity,
  );
}
