import { failureKind } from '../lib/retry-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { identity } from './recovery.mjs';

const hash = (x) => createHash('sha256').update(x).digest('hex');
export const codexProgressVersion = '2026-09-12.codex-progress1';

// One logical stage, exact input and cwd. Never resume --last or another task.
export async function runCodexProcess({
  stage,
  prompt,
  contract,
  cwd,
  dir,
  turnId,
  onChild = () => {},
  idleMs = Number(
    process.env.CODEX_STAGE_IDLE_MS ||
      process.env.CODEX_STAGE_TIMEOUT_MS ||
      900000,
  ),
  stopGraceMs = 10000,
}) {
  if (!(idleMs > 0) || !Number.isFinite(idleMs))
    throw Error('Codex 静默阈值无效');
  const logicalTurnId = turnId.replace(/\.attempt-\d+(?=\.|$)/, '');
  const key = hash(
    JSON.stringify({
      version: codexProgressVersion,
      stage,
      prompt,
      contract,
      cwd: fs.realpathSync(cwd),
      logicalTurnId,
    }),
  );
  const folder = path.join(dir, 'codex-progress');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const receipt = path.join(folder, key + '.json');
  let previous;
  if (fs.existsSync(receipt))
    previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (previous?.pidIdentity && identity(previous.pid) === previous.pidIdentity)
    throw Error('同一 Codex 阶段仍在运行，保留会话，禁止重复启动');
  const resumable =
    previous &&
    previous.key === key &&
    previous.status !== 'complete' &&
    previous.threadId;
  if (
    resumable &&
    ([
      { path: previous.tracePath, sha256: previous.traceSha256 },
      ...(previous.originalTraces || []),
    ].some((f) => hash(fs.readFileSync(f.path)) !== f.sha256) ||
      !/^[\w-]+$/.test(previous.threadId))
  )
    throw Error('Codex 恢复记录与原始输出不一致，保留原件等待核对');
  const prefix = path.join(
    dir,
    turnId +
      (['.events.jsonl', '.schema.json', '.json'].some((suffix) =>
        fs.existsSync(path.join(dir, turnId + '.' + stage + suffix)),
      )
        ? '.resume-' + randomUUID()
        : '') +
      '.' +
      stage,
  );
  const events = prefix + '.events.jsonl',
    last = prefix + '.json',
    schemaPath = prefix + '.schema.json';
  fs.writeFileSync(schemaPath, JSON.stringify(contract), {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(events, '', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(last, '', { flag: 'wx', mode: 0o600 });
  const state = {
    version: codexProgressVersion,
    key,
    stage,
    logicalTurnId,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastProgressAt: new Date().toISOString(),
    tracePath: events,
    outputPath: last,
    threadId: resumable ? previous.threadId : null,
    originalTracePaths: resumable
      ? [...(previous.originalTracePaths || []), previous.tracePath]
      : [],
    originalTraces: resumable
      ? [
          ...(previous.originalTraces || []),
          { path: previous.tracePath, sha256: previous.traceSha256 },
        ]
      : [],
    resumeCount: resumable ? (previous.resumeCount || 0) + 1 : 0,
  };
  const save = () => {
    fs.writeFileSync(receipt + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(receipt + '.tmp', receipt);
  };
  const args = [
    'exec',
    ...(resumable
      ? ['resume', previous.threadId, '-c', 'sandbox_mode="read-only"']
      : ['--sandbox', 'read-only']),
    '--skip-git-repo-check',
    '--json',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    last,
    '-',
  ];
  let output = '',
    pending = '',
    stalled = false,
    threadMismatch = false;
  const seen = new Set(),
    traceHash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const p = spawn('codex', args, {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    state.pid = p.pid;
    state.pidIdentity = p.pid ? identity(p.pid) : null;
    onChild(p);
    save();
    let hard,
      completed = false;
    const stop = () => {
      p.kill('SIGTERM');
      hard = setTimeout(() => p.kill('SIGKILL'), stopGraceMs);
    };
    const timer = setInterval(
      () => {
        if (
          !stalled &&
          Date.now() - Date.parse(state.lastProgressAt) >= idleMs
        ) {
          stalled = true;
          state.status = 'stalled';
          save();
          stop();
        }
      },
      Math.max(10, Math.min(5000, idleMs / 4)),
    );
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      output += chunk;
      pending += chunk;
      fs.appendFileSync(events, chunk);
      traceHash.update(chunk);
      state.traceSha256 = traceHash.copy().digest('hex');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (['error', 'turn.failed'].includes(e.type)) {
          const kind = failureKind(e.error?.message || e.message || '');
          if (kind !== 'unclassified') state.failureKind = kind;
        }
        if (e.type === 'thread.started') {
          if (state.threadId && state.threadId !== e.thread_id) {
            threadMismatch = true;
            stop();
          } else state.threadId = e.thread_id;
        }
        // Heartbeats, repeated records and stderr never extend the watchdog.
        if (
          e.item &&
          ['item.started', 'item.updated', 'item.completed'].includes(e.type)
        ) {
          const { id: _id, ...content } = e.item;
          const signature = hash(JSON.stringify([e.type, content]));
          if (!seen.has(signature)) {
            seen.add(signature);
            state.lastProgressAt = new Date().toISOString();
          }
        }
      }
      save();
    });
    p.stderr.on('data', (chunk) => {
      fs.appendFileSync(events + '.stderr.log', chunk);
      const kind = failureKind(chunk);
      if (['authentication', 'transport'].includes(kind))
        state.failureKind = kind;
    });
    const finish = (code, error) => {
      if (completed) return;
      completed = true;
      clearInterval(timer);
      clearTimeout(hard);
      onChild(null);
      state.status =
        code === 0 && !stalled && !threadMismatch && !error
          ? 'complete'
          : 'interrupted';
      state.finishedAt = new Date().toISOString();
      state.traceSha256 = hash(fs.readFileSync(events));
      save();
      if (state.status === 'complete') resolve();
      else {
        const failure =
          error ||
          Error(
            threadMismatch
              ? 'Codex 恢复返回其他会话，已停止并保留原件'
              : stalled
                ? `Codex ${stage} 长时间无有效进展，原会话和输出已保存待接续`
                : `Codex ${stage} ${state.failureKind === 'authentication' ? '认证失败，' : state.failureKind === 'transport' ? '网关或网络请求失败，' : ''}退出码 ${code}，原会话和输出已保存待接续`,
          );
        failure.codexRecovery = {
          path: receipt,
          threadId: state.threadId,
          tracePath: events,
        };
        reject(failure);
      }
    };
    p.on('error', (e) => finish(null, e));
    p.on('close', (code) => finish(code));
    p.stdin.on('error', () => {});
    p.stdin.end(
      (resumable
        ? '继续本会话被中断的同一阶段，利用已有读取和分析继续未完成部分。先核对当前证据仍适用，不将未完成的检查视为通过，不执行其他阶段。原任务和输出结构如下：\n'
        : '') + prompt,
    );
  });
  return {
    output,
    events,
    last,
    resumeReceipt: {
      path: receipt,
      threadId: state.threadId,
      resumeCount: state.resumeCount,
      originalTracePaths: state.originalTracePaths,
    },
  };
}
