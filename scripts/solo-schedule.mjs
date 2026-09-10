import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { savePrivateJSON } from './solo-client.mjs';
import { withSoloLock } from './solo-lock.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../.runner/solo-upload',
);
const file = path.join(root, 'schedule.json');
const load = () =>
  fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { timezone: 'Asia/Shanghai', times: ['08:00', '20:00'], runs: {} };

export function uploadSlot(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // The heartbeat wakes on the hour; tolerate delivery delay in that half hour.
  if (!['08', '20'].includes(parts.hour) || Number(parts.minute) >= 30)
    return null;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00+08:00`;
}

export function dueUpload(now, state) {
  const slot = uploadSlot(now);
  return {
    due: Boolean(slot && !state.runs?.[slot]),
    slot,
    timezone: 'Asia/Shanghai',
    times: ['08:00', '20:00'],
  };
}

async function main(action, value) {
  if (action === '--due') return dueUpload(new Date(), load());
  return withSoloLock(path.join(root, 'journal.lock'), async () => {
    const state = load();
    if (action === '--claim') {
      const due = dueUpload(new Date(), state);
      if (!due.due) return due;
      state.runs[due.slot] = {
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      savePrivateJSON(file, state);
      return { ...due, claimed: true };
    }
    if (action === '--finish') {
      const summary = JSON.parse(fs.readFileSync(value, 'utf8'));
      if (
        !state.runs[summary.slot] ||
        !['completed', 'blocked', 'failed'].includes(summary.status)
      )
        throw Error('上传批次回执无效');
      state.runs[summary.slot] = {
        ...state.runs[summary.slot],
        ...summary,
        finishedAt: new Date().toISOString(),
      };
      savePrivateJSON(file, state);
      return { slot: summary.slot, status: summary.status };
    }
    throw Error('用法：--due | --claim | --finish summary.json');
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv[2], process.argv[3])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
