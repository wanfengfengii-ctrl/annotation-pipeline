import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '../.runner');
export const cleanupIntervalSeconds = 10;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
}

// Only the bridge's exited receipt is authoritative. A completed Claude turn
// still leaves a live process for Bug follow-ups and must keep its Terminal.
export function exitedTerminals(root, isAlive = alive) {
  const records = [];
  for (const task of directories(root)) {
    for (const question of directories(path.join(task, 'questions'))) {
      const directory = path.join(question, 'terminal');
      try {
        const statePath = path.join(directory, 'state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        const spec = JSON.parse(
          readFileSync(path.join(directory, 'launch.json'), 'utf8'),
        );
        if (
          state.status !== 'exited' ||
          state.realTerminal !== true ||
          !Number.isInteger(state.exitCode) ||
          !/^\/dev\/ttys\d+$/.test(state.tty) ||
          !state.runId ||
          spec.transport !== 'mac-terminal' ||
          state.runId !== spec.runId ||
          spec.statePath !== statePath ||
          spec.launchPath !== path.join(directory, 'question.command') ||
          isAlive(state.pid) ||
          isAlive(state.childPid)
        )
          continue;
        records.push({
          runId: state.runId,
          tty: state.tty,
          launchPath: spec.launchPath,
        });
      } catch {
        // Missing or partially written receipts do not permit a close.
      }
    }
  }
  return records;
}

// This pure predicate also runs inside JXA. TTY numbers are reused on macOS,
// including while an older completed tab with that same TTY remains visible.
export function completedTerminalMatches(tab, record) {
  return (
    tab.tty === record.tty &&
    tab.busy === false &&
    Array.isArray(tab.processes) &&
    tab.processes.length === 0 &&
    /\[(?:进程已完成|Process completed)\]\s*$/.test(tab.contents) &&
    tab.history.replace(/\\ /g, ' ').includes(record.launchPath) &&
    tab.history.includes('This question terminal has ended.')
  );
}

export function cleanupScript(records, dryRun = false) {
  return `
const matches = ${completedTerminalMatches.toString()};
const records = ${JSON.stringify(records)};
const app = Application('com.apple.Terminal');
const result = { matched: [], closed: [], deferred: [], errors: [] };
if (app.running()) {
  const windows = app.windows();
  for (let wi = windows.length - 1; wi >= 0; wi--) {
    const window = windows[wi];
    try {
      // Terminal retains closed, invisible window objects with null tabs.
      const inspect = () => (window.tabs() || []).map(tab => {
        // Avoid reading live conversation text at all.
        if (tab.busy() || tab.processes().length !== 0) return null;
        const observed = { tty: tab.tty(), busy: tab.busy(), processes: tab.processes(),
          contents: tab.contents(), history: tab.history() };
        return records.find(record => matches(observed, record)) || null;
      });
      const observed = inspect();
      const owned = observed.filter(Boolean);
      if (!owned.length) continue;
      const identities = owned.map(record => ({ runId: record.runId,
        windowId: window.id(), tty: record.tty }));
      result.matched.push(...identities);
      // Terminal rejects close(tab) with -1708. Do not replace it with a
      // focus-dependent keypress that could close the user's active tab.
      // Pipeline launches use separate windows; a manually merged window
      // waits until every tab in it is one of our completed processes.
      if (owned.length !== observed.length) {
        result.deferred.push({ windowId: window.id(), reason: 'window_has_other_tabs' });
        continue;
      }
      if (${JSON.stringify(dryRun)}) continue;
      const fresh = inspect();
      if (fresh.length !== observed.length || fresh.some((record, i) =>
        !record || record.runId !== observed[i].runId)) continue;
      app.close(window, { saving: 'no' });
      result.closed.push(...identities);
    } catch (error) {
      result.errors.push({ code: Number(error.errorNumber) || 0 });
    }
  }
}
JSON.stringify(result);
`;
}

export function cleanupOnce(root = defaultRoot, dryRun = false) {
  const records = exitedTerminals(root);
  let result;
  try {
    result = JSON.parse(
      execFileSync('/usr/bin/osascript', ['-l', 'JavaScript'], {
        input: cleanupScript(records, dryRun),
        encoding: 'utf8',
        timeout: 15000,
      }),
    );
  } catch (error) {
    result = {
      matched: [],
      closed: [],
      deferred: [],
      errors: [{ code: error.code || error.status || 'unknown' }],
    };
  }
  if (!dryRun) {
    const statePath = path.join(root, 'terminal-cleanup.json');
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {}
    const state = {
      version: 1,
      intervalSeconds: cleanupIntervalSeconds,
      checkedAt: new Date().toISOString(),
      closedCount: (previous.closedCount || 0) + result.closed.length,
      closed: [...(previous.closed || []), ...result.closed].slice(-100),
      deferred: result.deferred,
      errors: result.errors,
    };
    mkdirSync(root, { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, statePath);
  }
  return result;
}

export function installCleanup(root = defaultRoot) {
  const suffix = createHash('sha256').update(root).digest('hex').slice(0, 12);
  const label = `com.annotation-pipeline.terminal-cleanup.${suffix}`;
  const directory = path.join(os.homedir(), 'Library/LaunchAgents');
  const plistPath = path.join(directory, label + '.plist');
  const xml = (text) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[
    process.execPath,
    scriptPath,
    '--root',
    root,
  ]
    .map((arg) => `<string>${xml(arg)}</string>`)
    .join('')}</array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${cleanupIntervalSeconds}</integer>
<key>ProcessType</key><string>Background</string>
</dict></plist>\n`;
  mkdirSync(directory, { recursive: true });
  const domain = `gui/${process.getuid()}`;
  let loaded = false;
  try {
    execFileSync('/bin/launchctl', ['print', `${domain}/${label}`], {
      stdio: 'ignore',
    });
    loaded = true;
  } catch {}
  if (
    loaded &&
    existsSync(plistPath) &&
    readFileSync(plistPath, 'utf8') === plist
  )
    return {
      label,
      plistPath,
      intervalSeconds: cleanupIntervalSeconds,
      existing: true,
    };
  if (loaded)
    execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], {
      stdio: 'ignore',
    });
  writeFileSync(plistPath, plist, { mode: 0o600 });
  execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], {
    stdio: 'ignore',
  });
  return { label, plistPath, intervalSeconds: cleanupIntervalSeconds };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    if (process.platform !== 'darwin') throw Error('Mac Terminal is required');
    const rootIndex = process.argv.indexOf('--root');
    const root =
      rootIndex < 0 ? defaultRoot : path.resolve(process.argv[rootIndex + 1]);
    const result = process.argv.includes('--install')
      ? installCleanup(root)
      : cleanupOnce(root, process.argv.includes('--dry-run'));
    console.log(JSON.stringify(result));
    if (result.errors?.length) process.exitCode = 1;
  } catch (error) {
    // Never copy Terminal history or launch descriptors into monitoring logs.
    console.error(
      '[terminal-cleanup] failed',
      error.code || error.status || 'unknown',
    );
    process.exitCode = 1;
  }
}
