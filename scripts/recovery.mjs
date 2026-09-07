import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
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
