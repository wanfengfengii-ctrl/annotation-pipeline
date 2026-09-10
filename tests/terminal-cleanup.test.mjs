import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  completedTerminalMatches,
  exitedTerminals,
  cleanupScript,
} from '../scripts/terminal-cleanup.mjs';

const record = {
  runId: 'run',
  tty: '/dev/ttys000',
  launchPath:
    '/New project/.runner/task/questions/old/terminal/question.command',
};
const ended = {
  tty: record.tty,
  busy: false,
  processes: [],
  contents: 'This question terminal has ended.\n\n[进程已完成]\n',
  history: `${record.launchPath}\nThis question terminal has ended.\n[进程已完成]\n`,
};

test('only completed owned tabs match, including escaped paths and English Terminal', () => {
  assert.equal(completedTerminalMatches(ended, record), true);
  assert.equal(
    completedTerminalMatches(
      {
        ...ended,
        contents: '[Process completed]\n',
        history: ended.history.replace('New project', 'New\\ project'),
      },
      record,
    ),
    true,
  );
  for (const patch of [
    { busy: true },
    { processes: ['Python'] },
    { processes: ['-zsh'] },
    { processes: undefined },
    { tty: '/dev/ttys001' },
    { contents: '[进程已完成]\n% ' },
    { contents: '❯ bypass permissions on' },
    { history: '[进程已完成]' },
    { history: ended.history.replace('This question terminal has ended.', '') },
  ])
    assert.equal(
      completedTerminalMatches({ ...ended, ...patch }, record),
      false,
    );
});

test('TTY reuse cannot match another question or a live tab in the same window', () => {
  assert.equal(
    completedTerminalMatches(
      { ...ended, history: ended.history.replace('/old/', '/new/') },
      record,
    ),
    false,
  );
  assert.equal(
    completedTerminalMatches(
      { ...ended, busy: true, processes: ['Python'] },
      record,
    ),
    false,
  );
});

test('exited bridge and child, matching launch identity, and valid receipts are required', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'terminal-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'task/questions/question/terminal');
  mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, 'state.json');
  const specPath = path.join(directory, 'launch.json');
  const state = {
    runId: 'run',
    realTerminal: true,
    status: 'exited',
    exitCode: 0,
    pid: 11,
    childPid: 12,
    tty: record.tty,
  };
  const spec = {
    runId: 'run',
    transport: 'mac-terminal',
    statePath,
    launchPath: path.join(directory, 'question.command'),
  };
  const write = (s = state, d = spec) => {
    writeFileSync(statePath, JSON.stringify(s));
    writeFileSync(specPath, JSON.stringify(d));
  };
  write();
  assert.equal(exitedTerminals(root, () => false).length, 1);
  for (const pid of [11, 12])
    assert.equal(exitedTerminals(root, (p) => p === pid).length, 0);
  for (const patch of [
    { status: 'running' },
    { status: 'error' },
    { exitCode: null },
    { realTerminal: false },
    { runId: 'other' },
    { tty: 'unknown' },
  ]) {
    write({ ...state, ...patch });
    assert.equal(exitedTerminals(root, () => false).length, 0);
  }
  for (const patch of [
    { statePath: '/other/state.json' },
    { launchPath: '/other/question.command' },
    { transport: 'pipe' },
  ]) {
    write(state, { ...spec, ...patch });
    assert.equal(exitedTerminals(root, () => false).length, 0);
  }
  write({ ...state, exitCode: 1 });
  assert.equal(exitedTerminals(root, () => false).length, 1);
  writeFileSync(statePath, '{"status":');
  assert.deepEqual(
    exitedTerminals(root, () => false),
    [],
  );
});

test('cleanup preserves mixed windows and rechecks every tab before closing a completed window', () => {
  const calls = [];
  const makeTab = (value, changeOnRead = false) => {
    let reads = 0;
    return {
      tty: () => value.tty,
      busy: () => value.busy,
      processes: () => value.processes,
      history: () => value.history,
      contents: () =>
        changeOnRead && reads++ ? '% new shell' : value.contents,
    };
  };
  const finished = makeTab(ended),
    active = makeTab({ ...ended, busy: true, processes: ['Python'] });
  const changed = makeTab(ended, true);
  const completedWindow = { id: () => 3, tabs: () => [makeTab(ended)] };
  const windows = [
    { id: () => 1, tabs: () => [finished, active] },
    { id: () => 2, tabs: () => [changed] },
    completedWindow,
    { id: () => 4, tabs: () => null },
  ];
  const app = {
    running: () => true,
    windows: () => windows,
    close: (target) => calls.push(target),
  };
  const evaluate = (dryRun) =>
    JSON.parse(
      runInNewContext(cleanupScript([record], dryRun), {
        Application: () => app,
      }),
    );
  const result = evaluate(false);
  assert.deepEqual(calls, [completedWindow]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.deferred, [
    { windowId: 1, reason: 'window_has_other_tabs' },
  ]);
  calls.length = 0;
  evaluate(true);
  assert.equal(calls.length, 0);
});
