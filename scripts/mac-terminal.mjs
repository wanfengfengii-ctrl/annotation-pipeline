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
        JSON.parse(received.split('\n')[0]).ok
          ? resolve()
          : reject(Error('终端拒绝了输入控制请求'));
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
