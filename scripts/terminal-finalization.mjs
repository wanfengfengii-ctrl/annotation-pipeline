import {
  readFileSync,
  writeFileSync,
  renameSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyNativeExport } from './evidence.mjs';

export const terminalFinalizationVersion = '2026-09-10.terminal-finalization1';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const terminalMatches = (terminal, directory) =>
  terminal &&
  ['statePath', 'launchPath'].every(
    (key, index) =>
      typeof terminal[key] === 'string' &&
      path.basename(terminal[key]) ===
        ['state.json', 'question.command'][index] &&
      realpathSync(path.dirname(terminal[key])) === directory,
  );
const isFinalExport = (value, questionId) =>
  value?.exportKind === 'final'
    ? path
        .basename(path.dirname(value.path))
        .startsWith(questionId + '.final.traces-')
    : !value?.exportKind &&
      /^final\.traces-\d+$/.test(
        path.basename(path.dirname(value?.path || '')),
      );
const inside = (file, root) => {
  const absolute = path.resolve(file);
  if (
    !absolute.startsWith(root + path.sep) ||
    realpathSync(absolute) !== absolute
  )
    throw Error('终端完成证据路径无效');
  if (!lstatSync(absolute).isFile()) throw Error('终端完成证据缺失');
  return absolute;
};

// A completed screen is insufficient. The final trace tree must still verify.
export function verifyTerminalFinalization({ taskDir, questionId, terminal }) {
  try {
    const root = realpathSync(taskDir);
    const directory = path.join(root, 'questions', questionId, 'terminal');
    if (!terminalMatches(terminal, directory)) return null;
    const file = inside(path.join(directory, 'finalization.json'), root);
    const bytes = readFileSync(file),
      saved = JSON.parse(bytes);
    if (
      saved.version !== terminalFinalizationVersion ||
      saved.taskId !== path.basename(root) ||
      saved.questionId !== questionId ||
      saved.runId !== terminal.runId ||
      saved.status !== 'removed' ||
      !/^[a-f0-9]{64}$/.test(saved.containerId || '') ||
      !isFinalExport(saved.traceExport, questionId) ||
      !Number.isFinite(Date.parse(saved.removedAt))
    )
      return null;
    const native = verifyNativeExport(saved.traceExport, {
      dir: root,
      containerId: saved.containerId,
      allowEmpty: saved.emptyWithoutCalls === true,
    });
    if (native.manifestSha256 !== saved.manifestSha256) return null;
    return { ...saved, receiptPath: file, receiptSha256: digest(bytes) };
  } catch {
    return null;
  }
}

export function writeTerminalFinalization(state, taskDir) {
  const root = realpathSync(taskDir),
    terminal = state.terminal;
  const directory = path.join(root, 'questions', state.questionId, 'terminal');
  if (
    state.status !== 'removed' ||
    state.taskId !== path.basename(root) ||
    !isFinalExport(state.traceExport, state.questionId) ||
    !terminal?.runId ||
    !terminalMatches(terminal, directory)
  )
    throw Error('最终导出和容器清理尚未完成，保留原终端');
  const emptyWithoutCalls =
    state.traceExport?.files === 0 &&
    !state.sessionId &&
    !state.pending &&
    Object.keys(state.results || {}).length === 0;
  const native = verifyNativeExport(state.traceExport, {
    dir: root,
    containerId: state.containerId,
    allowEmpty: emptyWithoutCalls,
  });
  const value = {
    version: terminalFinalizationVersion,
    taskId: state.taskId,
    questionId: state.questionId,
    runId: terminal.runId,
    containerId: state.containerId,
    sessionId: state.sessionId || null,
    status: 'removed',
    emptyWithoutCalls,
    commandTransport:
      state.finalCommandTransport === 'original-mac-terminal'
        ? 'original-mac-terminal'
        : 'legacy-runner-migration',
    traceExport: state.traceExport,
    manifestSha256: native.manifestSha256,
    removedAt: state.finishedAt || new Date().toISOString(),
  };
  const file = path.join(directory, 'finalization.json');
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temp, file);
  return value;
}
