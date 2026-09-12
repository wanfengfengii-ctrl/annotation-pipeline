import path from 'node:path';
import { readJSON, exactProcess } from './self-heal-io.mjs';
import { identity } from './recovery.mjs';

export const wakeProtocol = '2026-09-12.self-heal-wake1';
// Only signal a guardian that explicitly registered the wake protocol. In
// particular, never send a Node default signal to a legacy/foreign process.
export function wakeSelfHeal(workRoot) {
  try {
    const s = readJSON(path.join(workRoot, 'self-heal/state.json'));
    if (
      s?.wakeProtocol !== wakeProtocol ||
      !s.pidIdentity ||
      identity(s.pid) !== s.pidIdentity ||
      !exactProcess(s.pid, path.dirname(workRoot), 'scripts/self-heal.mjs')
    )
      return false;
    process.kill(s.pid, 'SIGUSR2');
    return true;
  } catch {
    return false;
  } // The short periodic poll remains the fallback.
}

export function createWakeSignal() {
  let pending = false,
    finish = null;
  return {
    wake() {
      if (finish) finish();
      else pending = true;
    },
    wait(ms) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      if (finish) throw Error('唤醒等待不能并发');
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(), ms);
        finish = () => {
          clearTimeout(timer);
          finish = null;
          resolve();
        };
      });
    },
  };
}
