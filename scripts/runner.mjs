import { spawn, execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token =
  process.env.RUNNER_TOKEN ||
  readFileSync(path.join(root, '.dev.vars'), 'utf8').match(
    /^RUNNER_TOKEN=(.+)$/m,
  )?.[1];
const base = process.env.PIPELINE_API_URL || 'http://localhost:3000';
const workRoot = path.join(root, '.runner');
mkdirSync(workRoot, { recursive: true });
const lock = path.join(workRoot, 'runner.lock');
try {
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
} catch {
  throw new Error(
    '执行器锁已存在。确认旧进程已退出后再删除 .runner/runner.lock',
  );
}
let stopping = false,
  child = null;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    child?.kill('SIGTERM');
  });
process.on('exit', () => {
  try {
    unlinkSync(lock);
  } catch {}
});
const command = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim();
const version = command('claude', ['--version'], root);
async function api(body) {
  const r = await fetch(base + '/api/runner', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const heartbeat = setInterval(
  () => api({ action: 'heartbeat', version }).catch(() => {}),
  10000,
);
function transcript(sessionId, prompt) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return {};
  for (const name of readdirSync(projects)) {
    const p = path.join(projects, name, `${sessionId}.jsonl`);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    for (const line of lines.reverse()) {
      try {
        const j = JSON.parse(line);
        const content = j.message?.content;
        const txt =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((x) => x.type === 'text')
                  .map((x) => x.text)
                  .join('')
              : '';
        if (j.type === 'user' && txt === prompt && j.uuid)
          return { promptId: j.uuid, nativeTrace: p };
      } catch {}
    }
  }
  return {};
}
async function execute({ task, turn }) {
  const dir = path.join(workRoot, task.id);
  mkdirSync(dir, { recursive: true });
  const tracePath = path.join(dir, turn.id + '.jsonl');
  const stderrPath = path.join(dir, turn.id + '.stderr.log');
  const result = {
    action: 'finish',
    taskId: task.id,
    turnId: turn.id,
    jobToken: turn.jobToken,
    success: false,
    tracePath,
    output: '',
    error: '',
    harnessVersion: version,
    os: `${os.platform()} ${os.release()}`,
    workDir: task.workDir || path.join(dir, 'workspace'),
    snapshot: task.snapshot,
    sessionId: task.sessionId || randomUUID(),
  };
  try {
    if (!task.workDir) {
      const repo = task.repoPath;
      const head = command('git', ['rev-parse', 'HEAD'], repo);
      if (command('git', ['status', '--porcelain'], repo))
        throw new Error('初始仓库有未提交改动，请先提交改动后再创建新会话。');
      const remote = command('git', ['remote', 'get-url', 'origin'], repo);
      const match = remote.match(
        /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/,
      );
      if (!match)
        throw new Error(
          '初始快照需要 GitHub origin，请先配置可供评测团队访问的远端仓库。',
        );
      command('git', ['fetch', '--no-tags', 'origin'], repo);
      if (
        !command(
          'git',
          [
            'for-each-ref',
            '--contains',
            head,
            '--format=%(refname)',
            'refs/remotes/origin',
          ],
          repo,
        )
      )
        throw new Error('初始提交尚未发布到 origin，请先推送后再创建新会话。');
      result.snapshot = `https://github.com/${match[1]}/${match[2]}/commit/${head}`;
      command(
        'git',
        ['worktree', 'add', '--detach', result.workDir, head],
        repo,
      );
      const localSettings = path.join(repo, '.claude', 'settings.local.json');
      if (existsSync(localSettings)) {
        mkdirSync(path.join(result.workDir, '.claude'), { recursive: true });
        copyFileSync(
          localSettings,
          path.join(result.workDir, '.claude', 'settings.local.json'),
        );
      }
    }
    const args = [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--replay-user-messages',
      ...(task.sessionId
        ? ['--resume', task.sessionId]
        : ['--session-id', result.sessionId]),
    ];
    // No --model / --settings / permission override: honor the installed CLI configuration.
    const requestedId = randomUUID();
    writeFileSync(tracePath, '');
    writeFileSync(stderrPath, '');
    const outFd = openSync(tracePath, 'a'),
      errFd = openSync(stderrPath, 'a');
    let buffer = '',
      final = null;
    await new Promise((resolve, reject) => {
      child = spawn('claude', args, {
        cwd: result.workDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let hardLimit;
      const limit = setTimeout(
        () => {
          child?.kill('SIGTERM');
          hardLimit = setTimeout(() => child?.kill('SIGKILL'), 10000);
        },
        Number(process.env.RUNNER_TIMEOUT_MS || 1800000),
      );
      child.stdout.on('data', (chunk) => {
        writeFileSync(outFd, chunk);
        buffer += chunk.toString();
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          try {
            const e = JSON.parse(line);
            if (e.type === 'system' && e.subtype === 'init') {
              result.model = e.model;
              result.sessionId = e.session_id || result.sessionId;
            }
            if (e.type === 'result') final = e;
            if (
              e.type === 'user' &&
              e.uuid &&
              (e.message?.content === turn.prompt ||
                JSON.stringify(e.message?.content).includes(
                  JSON.stringify(turn.prompt),
                ))
            )
              result.promptId = e.uuid;
          } catch {}
        }
      });
      child.stderr.on('data', (chunk) => writeFileSync(errFd, chunk));
      child.on('error', (e) => {
        clearTimeout(limit);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(limit);
        clearTimeout(hardLimit);
        closeSync(outFd);
        closeSync(errFd);
        child = null;
        if (!final || code !== 0 || final.is_error) {
          result.error =
            final?.errors?.join('\n') ||
            final?.result ||
            `Claude CLI 未正常完成（退出码 ${code}，信号 ${signal || '无'}）。查看 ${stderrPath}`;
        }
        result.output = final?.result || '';
        result.success = code === 0 && Boolean(final) && !final.is_error;
        resolve();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(
        JSON.stringify({
          type: 'user',
          uuid: requestedId,
          session_id: result.sessionId,
          message: { role: 'user', content: turn.prompt },
          parent_tool_use_id: null,
        }) + '\n',
      );
    });
    const native = transcript(result.sessionId, turn.prompt);
    if (native.promptId) {
      result.promptId = native.promptId;
      copyFileSync(
        native.nativeTrace,
        path.join(dir, turn.id + '.native.jsonl'),
      );
    }
  } catch (e) {
    result.error = e.message;
    result.success = false;
    if (!existsSync(result.workDir)) delete result.workDir;
    if (!existsSync(tracePath)) writeFileSync(tracePath, '');
    if (!task.sessionId && !result.output && !result.promptId)
      delete result.sessionId;
  }
  const receipt = path.join(dir, turn.id + '.result.json');
  writeFileSync(receipt, JSON.stringify(result, null, 2), { mode: 0o600 });
  return { result, receipt };
}
async function deliver(result, receipt) {
  await api(result);
  writeFileSync(receipt + '.delivered', 'ok');
}
console.log(`Claude 执行器就绪 · ${version} · ${base} · 使用 CLI 配置模型`);
try {
  for (const taskDir of readdirSync(workRoot)) {
    const p = path.join(workRoot, taskDir);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    for (const name of readdirSync(p).filter((x) =>
      x.endsWith('.result.json'),
    )) {
      const receipt = path.join(p, name);
      if (!existsSync(receipt + '.delivered'))
        await deliver(JSON.parse(readFileSync(receipt, 'utf8')), receipt);
    }
  }
  while (!stopping) {
    try {
      await api({ action: 'heartbeat', version });
      const { job } = await api({ action: 'claim' });
      if (job) {
        console.log(`开始：${job.task.title} / ${job.turn.id}`);
        const { result, receipt } = await execute(job);
        let delivered = false;
        while (!delivered && !stopping) {
          try {
            await deliver(result, receipt);
            delivered = true;
          } catch (e) {
            console.error('回写失败，将重试：' + e.message);
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        console.log(
          result.success
            ? '该轮已完成，等待人工评分'
            : '该轮异常：' + result.error,
        );
      } else await new Promise((r) => setTimeout(r, 2500));
    } catch (e) {
      console.error(e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
} finally {
  clearInterval(heartbeat);
}
