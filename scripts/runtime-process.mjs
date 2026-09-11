import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Output extends a soft deadline, never proves a successful assertion. A hard
// deadline bounds noisy/stuck processes; callers retain evidence and resume.
export function runRuntimeProcess(
  command,
  args,
  {
    timeoutSeconds = 30,
    maxTimeoutSeconds = timeoutSeconds,
    onChild = () => {},
    logPath,
  } = {},
) {
  return new Promise((resolve) => {
    let output = '',
      timedOut = false,
      limited = false,
      settled = false,
      extensions = 0,
      producedOutput = false;
    const started = Date.now(),
      soft = Math.max(1, timeoutSeconds * 1000),
      hard = Math.max(soft, maxTimeoutSeconds * 1000);
    let lastOutput = started,
      observedBytes = 0;
    if (logPath) writeFileSync(logPath, '', { mode: 0o600 });
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    onChild(p);
    let timer;
    const checkDeadline = () => {
      const elapsed = Date.now() - started;
      const bytes = Buffer.byteLength(output);
      if (
        elapsed < hard &&
        bytes > observedBytes &&
        Date.now() - lastOutput <= soft
      ) {
        observedBytes = bytes;
        extensions++;
        timer = setTimeout(checkDeadline, Math.min(soft, hard - elapsed));
        return;
      }
      timedOut = true;
      p.kill('SIGKILL');
    };
    timer = setTimeout(checkDeadline, soft);
    const append = (b) => {
      if (limited) return;
      let text = b.toString();
      if (text.trim()) {
        producedOutput = true;
        lastOutput = Date.now();
      }
      if (
        Buffer.byteLength(output) + Buffer.byteLength(text) >
        2 * 1024 * 1024
      ) {
        limited = true;
        text = '\n[日志超限，已保存输出，验收待恢复]\n';
        p.kill('SIGKILL');
      }
      output += text;
      if (logPath) appendFileSync(logPath, text);
    };
    p.stdout.on('data', append);
    p.stderr.on('data', append);
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChild(null);
      if (error) {
        const text = '\n' + error.message;
        output += text;
        if (logPath) appendFileSync(logPath, text);
      }
      if (!output.trim()) {
        output = '[命令没有输出]\n';
        if (logPath) writeFileSync(logPath, output, { mode: 0o600 });
      }
      resolve({
        exitCode,
        timedOut,
        limited,
        output,
        logPath,
        logSha256: createHash('sha256').update(output).digest('hex'),
        producedOutput,
        elapsedSeconds: (Date.now() - started) / 1000,
        extensions,
      });
    };
    p.on('error', (e) => finish(null, e));
    p.on('close', (code) => finish(code));
  });
}
