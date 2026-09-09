import { execFileSync, spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  containerImage,
  containerPolicyVersion,
  containerTraceRoot,
  dockerSnapshot,
} from '../lib/container-policy.mjs';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const bridgePath = fileURLToPath(new URL('./docker-pty.py', import.meta.url));
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
// Terminal escape bytes are deliberately removed before matching the fixed startup screen.
const compactTerminal = (s) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '');

export function dockerStatus() {
  try {
    const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
    const image = JSON.parse(docker(['image', 'inspect', containerImage]))[0];
    const digest = image.RepoDigests?.find((s) =>
      s.startsWith('adminfather/benzhi-claude-code@'),
    )?.split('@')[1];
    if (!/^sha256:[a-f0-9]{64}$/.test(digest || ''))
      throw Error('缺少已发布镜像摘要');
    return {
      ready: true,
      digest,
      cpus: info.NCPU,
      memoryBytes: info.MemTotal,
      image: containerImage,
      imageId: image.Id,
      arch: image.Architecture,
      reason: 'Docker 与作业镜像已就绪',
    };
  } catch {
    return {
      ready: false,
      image: containerImage,
      reason: 'Docker 未启动或缺少指定镜像，请启动 Docker 并拉取作业镜像',
    };
  }
}

function parseNativeJSONL(content) {
  const lines = content.split('\n'),
    events = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      if (i !== lines.length - 1 || content.endsWith('\n'))
        throw Error('原始轨迹包含损坏的 JSONL 记录');
    }
  }
  return events;
}

export function readNativeTurn(files, prompt, previousIds = []) {
  for (const file of files) {
    const events = parseNativeJSONL(file.content);
    const start = events.findIndex(
      (e) =>
        e.type === 'user' &&
        !e.isSidechain &&
        !previousIds.includes(e.uuid) &&
        e.message?.content === prompt,
    );
    if (start < 0) continue;
    const user = events[start];
    // Tool results also have type=user. Only a new plain-text user prompt ends a round.
    let end = events.findIndex(
      (e, i) =>
        i > start &&
        e.type === 'user' &&
        typeof e.message?.content === 'string',
    );
    if (end < 0) end = events.length;
    const round = events.slice(start, end);
    const complete = round.some(
      (e) => e.type === 'system' && e.subtype === 'turn_duration',
    );
    const assistants = round.filter((e) => e.type === 'assistant');
    const output = assistants
      .flatMap((e) =>
        (e.message?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text),
      )
      .join('\n');
    return {
      complete,
      promptId: user.uuid,
      sessionId: user.sessionId,
      model: assistants.at(-1)?.message?.model,
      output,
      error: round.some(
        (e) => e.isApiErrorMessage || e.subtype === 'api_error',
      ),
      content: round.map((e) => JSON.stringify(e)).join('\n') + '\n',
      nativeContent: file.content,
    };
  }
  return null;
}

const remoteFiles = `const fs=require('fs'),path=require('path'),crypto=require('crypto');const root=${JSON.stringify(containerTraceRoot)};function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('轨迹含符号链接');return e.isDirectory()?walk(p):[{name:path.relative(root,p),bytes:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}];});}console.log(JSON.stringify(walk(root)));`;
function localManifest(root) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) throw Error('轨迹含符号链接');
        return e.isDirectory()
          ? walk(p)
          : [
              {
                name: path.relative(root, p),
                bytes: lstatSync(p).size,
                sha256: hash(readFileSync(p)),
              },
            ];
      });
  return walk(root);
}
export function sameManifest(a, b) {
  return (
    JSON.stringify([...a].sort((x, y) => x.name.localeCompare(y.name))) ===
    JSON.stringify([...b].sort((x, y) => x.name.localeCompare(y.name)))
  );
}

export class DockerRuntime {
  constructor(
    root,
    report = async () => {},
    shouldStop = () => false,
    command = docker,
  ) {
    this.root = root;
    this.command = command;
    this.report = report;
    this.shouldStop = shouldStop;
    this.owner = hash(realpathSync(root)).slice(0, 24);
    this.live = new Map();
    this.cleanupAt = new Map();
  }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('任务 ID 无效');
    return path.join(this.root, id, 'container.json');
  }
  load(id) {
    const f = this.file(id);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }
  save(s) {
    const f = this.file(s.taskId);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(f + '.tmp', f);
  }
  public(s) {
    const { pending: _pending, results: _results, ...record } = s;
    return record;
  }
  async publish(s) {
    this.save(s);
    await this.report(this.public(s));
  }
  records() {
    return readdirSync(this.root)
      .filter((n) => /^[a-f0-9-]{36}$/.test(n))
      .map((n) => this.load(n))
      .filter(Boolean);
  }
  residents() {
    return this.records()
      .filter((s) => s.status !== 'removed')
      .map((s) => s.taskId);
  }
  owned(s) {
    const c = JSON.parse(this.command(['inspect', s.containerId || s.name]))[0];
    const m = c.Mounts;
    if (
      c.Config.Labels?.['annotation.pipeline.owner'] !== this.owner ||
      c.Config.Labels?.['annotation.pipeline.task'] !== s.taskId ||
      c.Image !== s.imageId ||
      c.Config.WorkingDir !== '/workspace' ||
      m.length !== 1 ||
      m[0].Type !== 'bind' ||
      m[0].Destination !== '/workspace' ||
      realpathSync(m[0].Source) !== realpathSync(s.workDir) ||
      c.HostConfig.Privileged ||
      c.HostConfig.RestartPolicy.Name !== 'no' ||
      !c.HostConfig.CapDrop?.includes('ALL') ||
      !c.HostConfig.SecurityOpt?.some((x) => x.startsWith('no-new-privileges'))
    )
      throw Error('容器身份或隔离配置不匹配，已停止操作');
    return c;
  }
  async ensure(task) {
    let s = this.load(task.id);
    if (s) {
      if (s.status === 'removed')
        throw Error('此项目容器已结束，请创建新任务；不恢复旧会话');
      const c = this.owned(s);
      if (!c.State.Running)
        throw Error('此项目容器已停止，只能导出归档，不能重启旧任务');
      s.containerId = c.Id;
      await this.attach(s, !s.bootstrapped);
      s.harnessVersion ||= this.command([
        'exec',
        s.containerId,
        'claude',
        '--version',
      ]);
      s.os ||= this.command(['exec', s.containerId, 'uname', '-sr']);
      await this.publish(s);
      return s;
    }
    if (task.sessionId || task.workDir)
      throw Error('旧版宿主机会话不能迁移续跑，请创建新的容器任务');
    const status = dockerStatus();
    if (!status.ready) throw Error(status.reason);
    const dir = path.dirname(this.file(task.id)),
      workDir = path.join(dir, 'workspace');
    mkdirSync(workDir, { recursive: true });
    if (
      lstatSync(workDir).isSymbolicLink() ||
      realpathSync(workDir) !== workDir
    )
      throw Error('新工作目录不能是符号链接');
    if (readdirSync(workDir).length)
      throw Error('新容器的工作目录必须完全为空，包括隐藏文件');
    const cfg = JSON.parse(
      readFileSync(path.join(os.homedir(), '.claude/settings.json'), 'utf8'),
    );
    const apikey = process.env.apikey || cfg.env?.ANTHROPIC_AUTH_TOKEN;
    if (!apikey) throw Error('缺少当前服务认证；未修改模型配置');
    s = {
      policyVersion: containerPolicyVersion,
      taskId: task.id,
      name: 'annotation-' + task.id,
      image: containerImage,
      imageId: status.imageId,
      snapshot: dockerSnapshot(status.digest),
      workDir,
      status: 'running',
      createdAt: new Date().toISOString(),
      initialWorkspaceEmpty: true,
      results: {},
    };
    // Persist the intent before creation; a crash cannot silently create a second container.
    this.save(s);
    try {
      s.containerId = this.command(
        [
          'run',
          '-dit',
          '--init',
          '--restart=no',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--cpus',
          '2',
          '--memory',
          '3g',
          '--label',
          'annotation.pipeline.owner=' + this.owner,
          '--label',
          'annotation.pipeline.task=' + task.id,
          '--name',
          s.name,
          '--mount',
          'type=bind,src=' + workDir + ',dst=/workspace',
          '-e',
          'apikey',
          status.imageId,
        ],
        { env: { ...process.env, apikey } },
      );
    } catch {
      s.status = 'error';
      s.error = '容器创建失败；请检查 Docker 状态，已保留工作目录与创建记录';
      this.save(s);
      throw Error(s.error);
    }
    this.save(s);
    this.owned(s);
    await this.attach(s, true);
    s.harnessVersion = this.command([
      'exec',
      s.containerId,
      'claude',
      '--version',
    ]);
    s.os = this.command(['exec', s.containerId, 'uname', '-sr']);
    await this.publish(s);
    return s;
  }
  async attach(s, fresh = false) {
    let live = this.live.get(s.taskId);
    if (live?.child.exitCode === null && s.bootstrapped) return;
    if (!live || live.child.exitCode !== null) {
      const child = spawn('python3', [bridgePath, s.containerId || s.name], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      live = {
        child,
        output: this.command([
          'logs',
          '--tail',
          '100',
          s.containerId || s.name,
        ]),
        error: '',
      };
      this.live.set(s.taskId, live);
      child.stdout.on('data', (d) => {
        live.output = (live.output + d).slice(-50000);
      });
      child.stderr.on('data', (d) => {
        live.error = (live.error + d).slice(-3000);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => {
        live.error = '无法连接容器交互终端';
      });
    }
    const child = live.child;
    await nap(2000);
    // Accept only this fixed image's first-run warning after isolation has been verified.
    if (fresh) {
      for (let i = 0; i < 20; i++) {
        const screen = compactTerminal(live.output);
        if (/bypasspermissionson/i.test(screen)) break;
        if (screen.includes('Yes,Iaccept') && screen.includes('No,exit')) {
          this.owned(s);
          child.stdin.write('\x1b[B');
          await nap(700);
          child.stdin.write('\r');
          await nap(1800);
          break;
        }

        if (child.exitCode !== null)
          throw Error('容器交互启动失败；容器已保留');
        await nap(500);
      }
    }
    if (child.exitCode !== null || !this.owned(s).State.Running)
      throw Error('容器交互终端未就绪');
    if (fresh && !/bypasspermissionson/i.test(compactTerminal(live.output)))
      throw Error('容器尚未进入输入状态，请检查本机容器终端；未发送题目');
    s.bootstrapped = true;
    this.save(s);
  }
  native(s) {
    const script = `const fs=require('fs'),p=${JSON.stringify(containerTraceRoot + '/-workspace')};console.log(JSON.stringify(fs.existsSync(p)?fs.readdirSync(p).filter(n=>n.endsWith('.jsonl')).map(n=>({name:n,content:fs.readFileSync(p+'/'+n,'utf8')})):[]));`;
    return JSON.parse(
      this.command(['exec', s.containerId || s.name, 'node', '-e', script]),
    );
  }
  async export(s, label, requireTrace = true) {
    const c = this.owned(s);
    const dest = path.join(
      path.dirname(this.file(s.taskId)),
      label + '.traces-' + Date.now(),
    );
    mkdirSync(path.join(dest, 'projects'), { recursive: true });
    // Stopped containers cannot exec; use their immutable copy as the source manifest.
    const before = c.State.Running
      ? JSON.parse(
          this.command([
            'exec',
            s.containerId || s.name,
            'node',
            '-e',
            remoteFiles,
          ]),
        )
      : null;
    this.command(
      [
        'cp',
        (s.containerId || s.name) + ':' + containerTraceRoot + '/.',
        path.join(dest, 'projects'),
      ],
      { timeout: 60000 },
    );
    const manifest = localManifest(path.join(dest, 'projects'));
    if (
      requireTrace &&
      !manifest.some((f) => f.name.endsWith('.jsonl') && f.bytes > 0)
    )
      throw Error('完整轨迹导出为空，容器已保留');
    if (before) {
      const after = JSON.parse(
        this.command([
          'exec',
          s.containerId || s.name,
          'node',
          '-e',
          remoteFiles,
        ]),
      );
      if (!sameManifest(before, manifest) || !sameManifest(after, manifest))
        throw Error('轨迹导出期间发生变化，容器已保留，请重试导出');
    } else {
      const verify = path.join(dest, 'verification');
      mkdirSync(verify);
      this.command(
        [
          'cp',
          (s.containerId || s.name) + ':' + containerTraceRoot + '/.',
          verify,
        ],
        { timeout: 60000 },
      );
      if (!sameManifest(manifest, localManifest(verify)))
        throw Error('停止后两次完整轨迹导出校验不一致，容器已保留');
    }
    writeFileSync(
      path.join(dest, 'manifest.json'),
      JSON.stringify({ containerId: c.Id, files: manifest }, null, 2),
      { mode: 0o600 },
    );
    return {
      verified: true,
      path: path.join(dest, 'projects'),
      manifestPath: path.join(dest, 'manifest.json'),
      files: manifest.length,
      sha256: hash(JSON.stringify(manifest)),
      exportedAt: new Date().toISOString(),
    };
  }
  async execute(task, turn, reserve) {
    const s = await this.ensure(task);
    if (s.results?.[turn.id])
      return { ...s.results[turn.id], container: this.public(s) };
    if (
      [...turn.prompt].some(
        (c) =>
          (c.charCodeAt(0) < 32 && !['\n', '\t'].includes(c)) ||
          c.charCodeAt(0) === 127,
      )
    )
      throw Error('任务包含终端控制字符，未发送');
    let p = s.pending;
    if (p && (p.turnId !== turn.id || p.promptHash !== hash(turn.prompt)))
      throw Error('容器中存在未确认的交互，请核对原始轨迹，不能发送新题');
    if (!p) {
      if (Object.keys(s.results).length >= 10)
        throw Error('同一窗口最多 10 次交互');
      const previousIds = this.native(s).flatMap((f) =>
        parseNativeJSONL(f.content)
          .filter((e) => e.type === 'user')
          .map((e) => e.uuid),
      );
      p = {
        turnId: turn.id,
        promptHash: hash(turn.prompt),
        previousIds,
        attemptId: turn.id,
        phase: 'reserved',
        startedAt: Date.now(),
      };
      s.pending = p;
      this.save(s);
      const quota = await reserve(p.attemptId, s.sessionId);
      if (!quota.allowed) {
        delete s.pending;
        this.save(s);
        throw Error('同一项目已达 10 次 Claude 交互上限');
      }
      p.count = quota.count;
      p.phase = 'sent';
      this.save(s);
      const live = this.live.get(task.id);
      live.child.stdin.write('\x1b[200~' + turn.prompt + '\x1b[201~');
      await nap(500);
      live.child.stdin.write('\r');
    }
    const deadline =
      Date.now() + Number(process.env.RUNNER_TIMEOUT_MS || 1800000);
    while (Date.now() < deadline) {
      if (this.shouldStop())
        throw Error('执行器停止，容器中的当前交互保留；重新连接后核对原始轨迹');
      if (!this.owned(s).State.Running)
        throw Error('容器交互已退出，保留容器供导出；不恢复或重发题目');
      const native = readNativeTurn(this.native(s), turn.prompt, p.previousIds);
      if (native?.complete) {
        if (s.sessionId && s.sessionId !== native.sessionId)
          throw Error('同一容器的会话 ID 发生变化');
        s.sessionId = native.sessionId;
        const traceExport = await this.export(s, turn.id);
        const dir = path.dirname(this.file(task.id)),
          tracePath = path.join(dir, turn.id + '.jsonl');
        writeFileSync(tracePath, native.content, { mode: 0o600 });
        writeFileSync(
          path.join(dir, turn.id + '.native.jsonl'),
          native.nativeContent,
          { mode: 0o600 },
        );
        const result = {
          success: !native.error,
          output: native.output,
          error: native.error ? 'Claude 原始轨迹报告调用错误' : '',
          sessionId: native.sessionId,
          promptId: native.promptId,
          model: native.model,
          harness: 'Claude Code',
          harnessVersion: s.harnessVersion,
          os: s.os,
          workDir: s.workDir,
          snapshot: s.snapshot,
          tracePath,
          traceExport,
          claudeCallCount: p.count,
          executionOutcome: native.error ? 'error' : 'complete',
          finishedAt: new Date().toISOString(),
        };
        s.results[turn.id] = result;
        delete s.pending;
        s.traceExport = traceExport;
        await this.publish(s);
        return { ...result, container: this.public(s) };
      }
      await nap(1500);
    }
    throw Error(
      '本轮未确认结束；已保留容器和调用额度，重试只核对原交互，不重发题目',
    );
  }
  async close(taskId) {
    const s = this.load(taskId);
    if (!s || s.status === 'removed') return;
    try {
      if (this.owned(s).State.Running) {
        await this.attach(s);
        const child = this.live.get(taskId).child;
        await nap(500);
        child.stdin.write('\x04');
        await nap(150);
        child.stdin.write('\x04');
        for (let i = 0; i < 20 && this.owned(s).State.Running; i++)
          await nap(500);
        if (this.owned(s).State.Running)
          throw Error('容器仍在运行，已保留；请在其终端结束当前操作后重试归档');
      }
      s.status = 'stopped';
      this.save(s);
      s.traceExport = await this.export(
        s,
        'final',
        Object.keys(s.results).length > 0 || s.pending?.phase === 'sent',
      );
      if (!existsSync(s.workDir) || !lstatSync(s.workDir).isDirectory())
        throw Error('宿主机代码目录缺失，容器已保留');
      s.status = 'exported';
      await this.publish(s);
      this.owned(s);
      this.command(['rm', s.containerId || s.name]);
      s.status = 'removed';
      s.finishedAt = new Date().toISOString();
      delete s.error;
      await this.publish(s);
      this.live.get(taskId)?.child.kill('SIGTERM');
      this.live.delete(taskId);
    } catch (e) {
      // A successful removal followed by a lost API acknowledgement must remain recoverable.
      if (
        s.status === 'exported' &&
        s.traceExport?.verified &&
        /No such (object|container)/i.test(String(e.stderr || ''))
      ) {
        s.status = 'removed';
        s.finishedAt = new Date().toISOString();
        delete s.error;
        await this.publish(s);
        return;
      }
      s.error = e.message;
      this.save(s);
      await this.report(this.public(s));
      throw e;
    }
  }
  async reconcile(tasks, active = new Set()) {
    for (const task of tasks) {
      if (active.has(task.id)) continue;
      const s = this.load(task.id);
      if (!s) continue;
      if (s.status === 'removed') {
        if (task.containerStatus !== 'removed')
          await this.report(this.public(s));
        continue;
      }
      if (task.closed || task.finishContainer) {
        if (Date.now() < (this.cleanupAt.get(task.id) || 0)) continue;
        this.cleanupAt.set(task.id, Date.now() + 60000);
        try {
          await this.close(task.id);
        } catch (e) {
          console.error('容器归档待重试：' + e.message);
        }
      } else {
        try {
          const c = this.owned(s);
          if (!c.State.Running && s.status === 'running') {
            s.status = 'stopped';
            await this.publish(s);
          }
        } catch {}
      }
    }
  }
  detach() {
    for (const { child } of this.live.values()) child.kill('SIGTERM');
    this.live.clear();
  }
}
