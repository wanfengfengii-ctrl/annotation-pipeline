import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const bridge = fileURLToPath(new URL('./terminal-session.py', import.meta.url));
export function prepareTerminal(directory, args) {
  const root = path.join(directory, 'terminal');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runId = randomUUID(),
    descriptor = {
      transport: 'mac-terminal',
      runId,
      statePath: path.join(root, 'state.json'),
      logPath: path.join(root, 'screen.log'),
      socketPath: '/tmp/annotation-terminal-' + runId + '.sock',
      launchPath: path.join(root, 'question.command'),
      specPath: path.join(root, 'launch.json'),
    };
  const dockerBinary = execFileSync('/usr/bin/which', ['docker'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    descriptor.specPath,
    JSON.stringify({ ...descriptor, dockerBinary, args }),
    { mode: 0o600 },
  );
  writeFileSync(
    descriptor.launchPath,
    '#!/bin/zsh\nexec /usr/bin/python3 ' +
      quote(bridge) +
      ' ' +
      quote(descriptor.specPath) +
      '\n',
    { mode: 0o700 },
  );
  return descriptor;
}
export function launchTerminal(descriptor) {
  if (process.platform !== 'darwin')
    throw Error('当前执行模式需要 Mac Terminal');
  writeFileSync(descriptor.launchPath + '.started', new Date().toISOString(), {
    flag: 'wx',
    mode: 0o600,
  });
  // Terminal owns the docker process; the runner never spawns or pipes into Claude.
  execFileSync('/usr/bin/open', ['-a', 'Terminal', descriptor.launchPath], {
    timeout: 15000,
    stdio: 'ignore',
  });
}
function state(d) {
  try {
    return JSON.parse(readFileSync(d.statePath, 'utf8'));
  } catch {
    return null;
  }
}
function screen(d) {
  if (!existsSync(d.logPath)) return '';
  const size = statSync(d.logPath).size,
    bytes = Math.min(size, 100000),
    fd = openSync(d.logPath, 'r'),
    buffer = Buffer.alloc(bytes);
  try {
    readSync(fd, buffer, 0, bytes, size - bytes);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
// Read only bytes appended after a checkpoint. A previous exit hint is not an
// acknowledgement of a new keypress, even when the terminal redraws slowly.
export function terminalOutput(d, cursor) {
  const size = statSync(d.logPath).size;
  const start = cursor === undefined ? Math.max(0, size - 100000) : cursor;
  if (!Number.isSafeInteger(start) || start < 0 || start > size)
    throw Error('终端输出游标失效，保留容器');
  if (size - start > 100000)
    throw Error('退出过程中终端输出过多，状态未知，保留容器');
  const fd = openSync(d.logPath, 'r'),
    buffer = Buffer.alloc(size - start);
  try {
    readSync(fd, buffer, 0, buffer.length, start);
    return { cursor: size, text: buffer.toString('utf8') };
  } finally {
    closeSync(fd);
  }
}
function exitScreen(text) {
  // eslint-disable-next-line no-control-regex
  const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  return (
    text
      .replace(osc, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  );
}
export function terminalExitReady(text) {
  const rendered = exitScreen(text);
  const prompt = rendered.slice(rendered.lastIndexOf('❯') + 1);
  return (
    rendered.includes('❯') &&
    /^[\s─━-]*(?:⏵⏵\s*)?bypass\s*permissions\s*on\b/i.test(prompt) &&
    !/esc\s*to\s*interrupt/i.test(prompt)
  );
}
export async function exitCompletedTerminal({
  readOutput,
  write,
  isRunning,
  assertIdle,
  wait = nap,
  now = Date.now,
  timeoutMs = 15000,
  maxInputs = 6,
}) {
  const guard = async () => {
    if (!(await isRunning())) return false;
    try {
      await assertIdle();
    } catch (e) {
      // Native inspection uses docker exec. A naturally exited container can
      // race that read; only a fresh stopped observation resolves the race.
      if (!(await isRunning())) return false;
      throw e;
    }
    return true;
  };
  if (!(await guard())) return { inputs: 0, confirmed: true };
  const initial = readOutput();
  if (!terminalExitReady(initial.text))
    throw Error('终端不是可确认的空闲输入状态，已保留容器');
  let cursor = initial.cursor,
    appended = '',
    inputs = 0;
  const deadline = now() + timeoutMs;
  const send = async () => {
    if (!(await guard())) return false;
    if (now() >= deadline) throw Error('终端退出确认超时，已保留容器');
    if (!(await isRunning())) return false;
    // IPC acknowledgement means delivery only, not that Claude consumed EOF.
    // Never resend an input whose acknowledgement is missing.
    await write('\x04');
    inputs++;
    return true;
  };
  if (!(await send())) return { inputs, confirmed: true };
  while (now() < deadline) {
    await wait(50);
    if (!(await isRunning())) return { inputs, confirmed: true };
    const fresh = readOutput(cursor);
    cursor = fresh.cursor;
    appended = (appended + fresh.text).slice(-100000);
    // Confirm only after a new hint. Claude's native double-press window is
    // 800 ms; do not sleep through it or assume two blind writes will work.
    if (/Press\s+Ctrl-D\s+again\s+to\s+exit/i.test(exitScreen(appended))) {
      appended = '';
      if (inputs >= maxInputs) break;
      if (!(await send())) return { inputs, confirmed: true };
    }
  }
  throw Error('容器仍在运行，退出确认未完成，已保留原容器和轨迹');
}
function input(d, text) {
  return new Promise((resolve, reject) => {
    const s = createConnection(d.socketPath);
    let received = '';
    const timer = setTimeout(() => {
      s.destroy();
      reject(Error('终端输入未确认，保留调用额度且不重发'));
    }, 10000);
    s.once('connect', () =>
      s.write(
        JSON.stringify({
          runId: d.runId,
          op: 'input',
          data: Buffer.from(text).toString('base64'),
        }) + '\n',
      ),
    );
    s.on('data', (data) => {
      received += data;
      if (received.includes('\n')) {
        clearTimeout(timer);
        s.end();
        if (JSON.parse(received.split('\n')[0]).ok) resolve();
        else reject(Error('终端拒绝了输入控制请求'));
      }
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.once('close', () => {
      clearTimeout(timer);
      if (!received.includes('\n')) reject(Error('终端输入结果未确认'));
    });
  });
}
export async function connectTerminal(d) {
  if (!d || d.transport !== 'mac-terminal')
    throw Error('旧版后台终端不能继续采集，请创建新终端会话');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const s = state(d);
    if (s?.runId === d.runId) {
      if (s.status === 'error' || s.status === 'exited')
        throw Error('题目终端已退出，保留容器导出，不恢复旧会话');
      if (s.realTerminal && s.tty && s.status === 'running') {
        process.kill(s.pid, 0);
        return {
          get output() {
            return screen(d);
          },
          get error() {
            return state(d)?.error || '';
          },
          child: {
            get exitCode() {
              const v = state(d);
              return v?.status === 'running' ? null : v?.exitCode || 1;
            },
            stdin: { write: (data) => input(d, data) },
            kill() {
              /* Terminal exits through its own Ctrl-D flow. */
            },
          },
          identity: {
            transport: d.transport,
            runId: d.runId,
            tty: s.tty,
            realTerminal: true,
          },
        };
      }
    }
    await nap(250);
  }
  throw Error('Mac Terminal 尚未就绪，未发送题目；请检查新打开的终端窗口');
}
