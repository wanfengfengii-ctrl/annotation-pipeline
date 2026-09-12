import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Full evidence is streamed to disk. The model-facing excerpt is bounded;
// logging volume never terminates a healthy verification process.
export function runRuntimeProcess(
  command,
  args,
  {
    timeoutSeconds = 30,
    maxTimeoutSeconds = timeoutSeconds,
    onChild = () => {},
    logPath = path.join(
      os.tmpdir(),
      'annotation-runtime-' + randomUUID() + '.log',
    ),
    stopGraceMs = 1000,
    excerptBytes = 2 * 1024 * 1024,
  } = {},
) {
  return new Promise((resolve) => {
    let timedOut = false,
      limited = false,
      settled = false,
      extensions = 0,
      producedOutput = false,
      outputBytes = 0,
      output = '',
      tail = '',
      lastOutput = Date.now(),
      stopTimer,
      storageError,
      progressTail = '';
    const started = Date.now(),
      idle = Math.max(1, timeoutSeconds * 1000),
      reviewAfter = Math.max(idle, maxTimeoutSeconds * 1000),
      digest = createHash('sha256'),
      seen = new Set();
    writeFileSync(logPath, '', { mode: 0o600 });
    const p = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(p);
    const stop = () => {
      p.kill('SIGTERM');
      stopTimer = setTimeout(() => p.kill('SIGKILL'), stopGraceMs);
    };
    const saveProgress = () => {
      try {
        writeFileSync(
          logPath + '.progress.json',
          JSON.stringify({
            startedAt: new Date(started).toISOString(),
            lastProgressAt: new Date(lastOutput).toISOString(),
            outputBytes,
            reviewDue: Date.now() - started > reviewAfter,
            status: storageError
              ? 'failed'
              : timedOut
                ? 'stalled'
                : settled
                  ? 'complete'
                  : 'running',
          }),
          { mode: 0o600 },
        );
      } catch (error) {
        storageError ||= error;
      }
    };
    const check = () => {
      if (!timedOut && Date.now() - lastOutput >= idle) {
        timedOut = true;
        stop();
      } else if (!timedOut && producedOutput) extensions++;
      saveProgress();
    };
    const timer = setInterval(check, Math.max(10, Math.min(1000, idle / 3)));
    const append = (chunk) => {
      // Preserve raw bytes and their digest, including split UTF-8 sequences.
      try {
        appendFileSync(logPath, chunk);
        digest.update(chunk);
      } catch (error) {
        if (!storageError) {
          storageError = error;
          limited = true;
          stop();
        }
        return;
      }
      outputBytes += chunk.length;
      const text = chunk.toString('utf8');
      if (text.trim()) producedOutput = true;
      if (Buffer.byteLength(output) < excerptBytes / 2)
        output += text.slice(
          0,
          Math.max(0, excerptBytes / 2 - Buffer.byteLength(output)),
        );
      tail = (tail + text).slice(-excerptBytes / 2);
      progressTail += text;
      // Repeated spinners and identical status messages do not refresh progress.
      const lines = progressTail.split(/[\r\n]+/);
      progressTail = lines.pop().slice(-8192);
      if (progressTail.length >= 8192) {
        lines.push(progressTail);
        progressTail = '';
      }
      for (const line of lines) {
        // eslint-disable-next-line no-control-regex -- Strip terminal ANSI only for progress detection.
        const normalized = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        if (!normalized) continue;
        const signature = createHash('sha256').update(normalized).digest('hex');
        if (!seen.has(signature)) {
          seen.add(signature);
          lastOutput = Date.now();
        }
      }
      // Bound watchdog state, while retaining every byte in the evidence file.
      if (seen.size > 10000) {
        const last = [...seen].slice(-5000);
        seen.clear();
        for (const x of last) seen.add(x);
      }
    };
    p.stdout.on('data', append);
    p.stderr.on('data', append);
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(stopTimer);
      onChild(null);
      if (error) append(Buffer.from('\n' + error.message));
      if (!outputBytes) {
        append(Buffer.from('[命令没有输出]\n'));
        producedOutput = false;
      }
      saveProgress();
      // Small outputs stay exact; large excerpts never claim to be full logs.
      const truncated = outputBytes > excerptBytes;
      resolve({
        exitCode,
        timedOut,
        limited: limited || !!storageError,
        output: truncated
          ? output + '\n[阅读摘要，完整日志见 logPath]\n' + tail
          : readFileSync(logPath, 'utf8'),
        outputTruncated: truncated,
        outputBytes,
        logPath,
        logSha256: digest.digest('hex'),
        producedOutput,
        elapsedSeconds: (Date.now() - started) / 1000,
        extensions,
        lastProgressAt: new Date(lastOutput).toISOString(),
        pauseReason: timedOut
          ? 'no-progress'
          : storageError
            ? 'log-storage-failed'
            : null,
      });
    };
    p.on('error', (error) => finish(null, error));
    p.on('close', (code) => finish(code));
  });
}
