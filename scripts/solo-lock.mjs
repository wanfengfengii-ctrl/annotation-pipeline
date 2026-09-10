import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Serializes journal transactions; a durable `submitting` entry reserves the
// record while the browser is outside this short-lived process.
export function acquireSoloLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, nonce: randomUUID() };
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw Error('已有 SOLO 台账操作运行；若进程已退出，核对锁文件后再恢复');
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
  } finally {
    fs.closeSync(fd);
  }
  return () => {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.nonce !== owner.nonce) throw Error('SOLO 锁所有者发生变化');
    fs.unlinkSync(file);
  };
}

export async function withSoloLock(file, run) {
  const release = acquireSoloLock(file);
  try {
    return await run();
  } finally {
    release();
  }
}
