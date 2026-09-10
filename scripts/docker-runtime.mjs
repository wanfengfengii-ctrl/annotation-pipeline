import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  realpathSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  prepareTerminal,
  launchTerminal,
  connectTerminal,
  terminalOutput,
  exitCompletedTerminal,
} from './mac-terminal.mjs';
import { sessionLimits } from '../lib/project-series.mjs';
import {
  auditPermissionTraces,
  verifyPermissionPreflight,
} from '../lib/permission-audit.mjs';
import { questionRoot, priorQuestionTurn } from '../lib/question-session.mjs';
import { terminalConfirmation } from '../lib/terminal-confirmation.mjs';
import { NativeProgressWatch } from './native-progress.mjs';
import {
  containerImage,
  containerPolicyVersion,
  containerTraceRoot,
  dockerSnapshot,
  resourceProfile,
} from '../lib/container-policy.mjs';

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (data) => createHash('sha256').update(data).digest('hex');
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

export function dockerStatus({ command = docker, timeout = 30000 } = {}) {
  try {
    const info = JSON.parse(
      command(['info', '--format', '{{json .}}'], { timeout }),
    );
    const image = JSON.parse(
      command(['image', 'inspect', containerImage], { timeout }),
    )[0];
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

export function dockerMemoryBytes(value) {
  const m = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(B|[KMGTPE]i?B)$/i);
  if (!m) throw Error('无法读取 Docker 内存用量');
  const unit = m[2].toUpperCase();
  const exponent = unit === 'B' ? 0 : 'KMGTPE'.indexOf(unit[0]) + 1;
  return Number(m[1]) * (unit.includes('I') ? 1024 : 1000) ** exponent;
}

const resourceReadScript = `// ANNOTATION_RESOURCE_SAMPLE
const fs = require('fs');
const read = p => fs.readFileSync(p, 'utf8');
const mem = read('/proc/meminfo');
const psi = read('/proc/pressure/memory');
const stat = read('/sys/fs/cgroup/memory.stat');
const max = read('/sys/fs/cgroup/memory.max').trim();
const num = (s, re) => {const m = s.match(re); if (!m) throw Error('missing resource field'); return Number(m[1]);};
console.log(JSON.stringify({
  memAvailableBytes: num(mem, /^MemAvailable:\\s+(\\d+)/m) * 1024,
  pressure: {someAvg10: num(psi, /^some avg10=(\\d+(?:\\.\\d+)?)/m), fullAvg10: num(psi, /^full avg10=(\\d+(?:\\.\\d+)?)/m)},
  cgroup: {currentBytes: Number(read('/sys/fs/cgroup/memory.current').trim()), maxBytes: max === 'max' ? null : Number(max), inactiveFileBytes: num(stat, /^inactive_file (\\d+)/m)}
}));`;

export function sampleDockerResources({
  owner,
  command = docker,
  timeout = 5000,
}) {
  const observedAt = new Date().toISOString();
  const deadline = Date.now() + timeout;
  const run = (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('Docker 资源采样超时');
    return command(args, { timeout: remaining });
  };
  try {
    const ids = run(['ps', '-q']).trim().split(/\s+/).filter(Boolean);
    if (!ids.length)
      return {
        ok: true,
        observedAt,
        ownedContainers: [],
        externalWorkingSetBytes: 0,
        vmObserved: false,
      };
    // Only these fields leave inspect; Config.Env can contain authentication.
    const inspected = run([
      'inspect',
      '--format',
      '{"id":{{json .Id}},"owner":{{json (index .Config.Labels "annotation.pipeline.owner")}},"memoryLimitBytes":{{json .HostConfig.Memory}}}',
      ...ids,
    ])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const stats = run([
      'stats',
      '--no-stream',
      '--format',
      '{{json .}}',
      ...ids,
    ])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const containers = inspected.map((c) => {
      const stat = stats.find(
        (s) => typeof s.ID === 'string' && c.id.startsWith(s.ID),
      );
      if (!stat?.MemUsage) throw Error('Docker 容器用量采样不完整');
      return {
        ...c,
        workingSetBytes: dockerMemoryBytes(stat.MemUsage.split('/')[0]),
      };
    });
    if (containers.length !== ids.length)
      throw Error('Docker 容器清单采样不完整');
    const own = containers.filter((c) => c.owner === owner);
    const externalWorkingSetBytes = containers
      .filter((c) => c.owner !== owner)
      .reduce((sum, c) => sum + c.workingSetBytes, 0);
    const sample = {
      ok: true,
      observedAt,
      ownedContainers: own.map(({ id, workingSetBytes, memoryLimitBytes }) => ({
        id,
        workingSetBytes,
        memoryLimitBytes,
      })),
      externalWorkingSetBytes,
      vmObserved: false,
    };
    if (!own.length) return sample;
    // Read only our own container. /proc/meminfo and PSI describe the shared
    // Linux VM; cgroup readings validate the observation container's limit.
    const vm = JSON.parse(
      run(['exec', own[0].id, 'node', '-e', resourceReadScript]),
    );
    if (
      !Number.isFinite(vm.memAvailableBytes) ||
      vm.memAvailableBytes < 0 ||
      !Number.isFinite(vm.pressure?.someAvg10) ||
      !Number.isFinite(vm.pressure?.fullAvg10) ||
      !Number.isFinite(vm.cgroup?.currentBytes) ||
      vm.cgroup.maxBytes !== own[0].memoryLimitBytes ||
      !Number.isFinite(vm.cgroup.inactiveFileBytes)
    )
      throw Error('Docker 虚拟机资源采样无效');
    sample.ownedContainers[0].workingSetBytes = Math.max(
      sample.ownedContainers[0].workingSetBytes,
      vm.cgroup.currentBytes - vm.cgroup.inactiveFileBytes,
    );
    return {
      ...sample,
      vmObserved: true,
      memAvailableBytes: vm.memAvailableBytes,
      pressure: vm.pressure,
    };
  } catch {
    // Sampling errors must not reveal raw Docker output or credentials, and
    // must never turn into optimistic admission after a transient failure.
    return { ok: false, observedAt, reason: 'Docker 资源采样失败，暂停新任务' };
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
      harnessVersion: user.version,
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

export function assertNativeSessionIdle(state, files) {
  if (state.pending) throw Error('题目仍有待确认或执行中的输入，保留容器');
  const completed = [];
  for (const file of files) {
    if (file.content && !file.content.endsWith('\n')) {
      try {
        JSON.parse(file.content.slice(file.content.lastIndexOf('\n') + 1));
      } catch {
        throw Error('原生轨迹末行尚未写完，状态未知，保留容器');
      }
    }
    const events = parseNativeJSONL(file.content);
    const userIndex = events.findLastIndex(
      (e) =>
        !e.isSidechain &&
        e.type === 'user' &&
        typeof e.message?.content === 'string',
    );
    if (userIndex < 0) {
      if (events.some((e) => e.type === 'assistant' || e.type === 'user'))
        throw Error('原生会话有无法归属的活动，保留容器');
      continue;
    }
    const user = events[userIndex];
    const after = events.slice(userIndex + 1);
    const duration = after.findLastIndex(
      (e) =>
        !e.isSidechain && e.type === 'system' && e.subtype === 'turn_duration',
    );
    if (
      duration < 0 ||
      after
        .slice(duration + 1)
        .some((e) => e.type === 'assistant' || e.type === 'user')
    )
      throw Error('最后实际用户轮尚未确认完成，保留容器');
    const result = Object.values(state.results || {}).find(
      (r) => r.promptId === user.uuid && r.sessionId === user.sessionId,
    );
    if (
      !result?.success ||
      !result.traceExport?.verified ||
      user.sessionId !== state.sessionId
    )
      throw Error('最后实际用户轮缺少已归档的成功回执，保留容器');
    completed.push(user.uuid);
  }
  if (!completed.length && Object.keys(state.results || {}).length)
    throw Error('已有调用记录但原生会话缺失，保留容器');
  return { completedPromptIds: completed, empty: !completed.length };
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
    this.resourceCache = null;
  }
  resourceStatus({ force = false } = {}) {
    const residentKey = this.records()
      .filter((s) => s.status !== 'removed')
      .map((s) => (s.containerId || s.name) + ':' + s.status)
      .sort()
      .join('|');
    if (
      !force &&
      this.resourceCache &&
      this.resourceCache.residentKey === residentKey &&
      Date.now() - this.resourceCache.at < 15000
    )
      return this.resourceCache.value;
    const value = dockerStatus({ command: this.command, timeout: 5000 });
    if (value.ready) {
      value.resourceSample = sampleDockerResources({
        owner: this.owner,
        command: this.command,
      });
      const sample = value.resourceSample;
      if (sample.ok) {
        const profile = resourceProfile();
        sample.reason = sample.ownedContainers.some(
          (c) => c.workingSetBytes >= c.memoryLimitBytes * 0.9,
        )
          ? '现有作业接近容器内存上限，暂停新增任务'
          : sample.pressure?.someAvg10 >= 10 || sample.pressure?.fullAvg10 >= 1
            ? 'Docker 虚拟机内存压力较高，暂停新增任务'
            : sample.vmObserved &&
                sample.memAvailableBytes <
                  profile.dockerReserveBytes + profile.memoryBytes
              ? 'Docker 虚拟机可用内存偏低，限制新增任务'
              : sample.vmObserved
                ? '已按实际容器限额与虚拟机可用内存核算'
                : '等待首个作业容器观测虚拟机资源';
      }
    }
    this.resourceCache = { at: Date.now(), residentKey, value };
    return value;
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
      m[0].RW !== true ||
      realpathSync(m[0].Source) !== realpathSync(s.workDir) ||
      c.HostConfig.Privileged ||
      c.HostConfig.RestartPolicy.Name !== 'no' ||
      !c.HostConfig.CapDrop?.includes('ALL') ||
      !c.HostConfig.SecurityOpt?.some((x) => x.startsWith('no-new-privileges'))
    )
      throw Error('容器身份或隔离配置不匹配，已停止操作');
    return c;
  }
  environmentEvidence(task, turn) {
    const s = this.load(task.id);
    if (!s || s.questionId !== questionRoot(task, turn))
      throw Error('环境证据与当前题目不匹配');
    const c = this.owned(s);
    if (!c.State.Running) throw Error('当前题目容器未运行');
    // Docker inspect contains authentication in Config.Env. Export only this allowlist.
    return {
      version: '2026-09-09.environment1',
      source: 'runner / Docker CLI inspect',
      checkedAt: new Date().toISOString(),
      taskId: s.taskId,
      questionId: s.questionId,
      containerId: c.Id,
      running: c.State.Running,
      image: s.image,
      imageId: c.Image,
      snapshot: s.snapshot,
      workDir: s.workDir,
      mount: {
        source: c.Mounts[0].Source,
        destination: '/workspace',
        writable: true,
      },
      isolationVerified: true,
      initialWorkspaceEmpty: s.initialWorkspaceEmpty,
      os: s.os,
      terminalIdentity: s.terminalIdentity,
      permissionPreflight: s.permissionPreflight,
    };
  }
  async ensure(task, turn) {
    const questionId = questionRoot(task, turn);
    let rotating = false;
    let s = this.load(task.id);
    if (s && (s.questionId || task.turns?.[0]?.id) !== questionId) {
      if (turn.repairOf || turn.continuationOf)
        throw Error('不能将原题继续关联到其他容器');
      await this.close(task.id);
      s = this.load(task.id);
      if (s.status !== 'removed') throw Error('上一题容器尚未完成归档清理');
      writeFileSync(
        path.join(
          path.dirname(this.file(task.id)),
          'container-' + (s.questionId || task.turns[0].id) + '.json',
        ),
        JSON.stringify(s, null, 2),
        { mode: 0o600 },
      );
      s = null;
      rotating = true;
    }
    if (s) {
      if (s.permissionAudit && !s.permissionAudit.passed)
        throw Error('本会话权限核验未通过，原始轨迹已保留，需新建任务重新采集');
      if (s.status === 'removed')
        throw Error('此题容器已结束，请创建新任务；不恢复旧会话');
      const c = this.owned(s);
      if (!c.State.Running)
        throw Error('此题容器已停止，只能导出归档，不能重启旧任务');
      s.containerId = c.Id;
      await this.attach(s, !s.bootstrapped);
      s.os ||= this.command(['exec', s.containerId, 'uname', '-sr']);
      this.importPriorQuestion(s, task, turn);
      s.permissionPreflight = this.permissionPreflight(s);
      await this.publish(s);
      return s;
    }
    if (!rotating && (task.sessionId || task.workDir))
      throw Error('旧版宿主机会话不能迁移续跑，请创建新的容器任务');
    const status = dockerStatus();
    if (!status.ready) throw Error(status.reason);
    const dir = path.dirname(this.file(task.id)),
      workDir = path.join(dir, 'questions', questionId, 'workspace');
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
      questionId,
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
      const profile = resourceProfile();
      s.terminal = prepareTerminal(path.dirname(workDir), [
        'run',
        '-it',
        '--sig-proxy=false',
        '--init',
        '--restart=no',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--cpus',
        String(profile.cpus),
        '--memory',
        profile.memoryArg,
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
      ]);
      this.save(s);
      launchTerminal(s.terminal);
      const live = await connectTerminal(s.terminal);
      this.live.set(task.id, live);
      s.terminalIdentity = live.identity;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          s.containerId = this.owned(s).Id;
          break;
        } catch {
          await nap(250);
        }
      }
      if (!s.containerId) throw Error('Terminal 容器尚未启动');
    } catch {
      s.status = 'error';
      s.error = '容器创建失败；请检查 Docker 状态，已保留工作目录与创建记录';
      this.save(s);
      throw Error(s.error);
    }
    this.save(s);
    this.owned(s);
    await this.attach(s, true);
    s.os = this.command(['exec', s.containerId, 'uname', '-sr']);
    s.permissionPreflight = this.permissionPreflight(s);
    this.importPriorQuestion(s, task, turn);
    s.permissionPreflight = this.permissionPreflight(s);
    await this.publish(s);
    return s;
  }
  importPriorQuestion(s, task, turn) {
    const previous = priorQuestionTurn(task, turn);
    if (!previous || turn.repairOf || turn.continuationOf || s.sourceSnapshot)
      return;
    if (
      !previous.permissionAudit?.passed ||
      (previous.sessionId &&
        task.turns.some(
          (r) =>
            r.sessionId === previous.sessionId &&
            r.permissionAudit &&
            !r.permissionAudit.passed,
        ))
    )
      throw Error('上一题缺少合格的权限核验，不能导入其代码');
    const retained = previous.automation?.projectContinuation?.sourceSnapshot;
    const evidence = retained?.verified
      ? path.dirname(retained.manifestPath)
      : path.join(path.dirname(this.file(task.id)), previous.id + '.evidence');
    const manifestPath = path.join(evidence, 'manifest.json');
    const manifestBytes = readFileSync(manifestPath);
    if (retained?.verified && hash(manifestBytes) !== retained.manifestSha256)
      throw Error('异常题保留代码快照摘要不匹配');
    const manifest = JSON.parse(manifestBytes);
    if (
      (manifest.omitted || []).some(
        (f) =>
          !['版本库内部文件或可重新安装的依赖/缓存', '敏感配置文件'].includes(
            f.reason,
          ),
      )
    )
      throw Error('上一题代码快照存在无法自动恢复的排除项，需处理后再出新题');
    const files = manifest.files.filter((f) => f.name.startsWith('workspace/'));
    if (!files.length) throw Error('上一题没有可核验的代码快照');
    const sourceHash = hash(manifestBytes);
    if (s.importing && s.importing !== sourceHash)
      throw Error('导入中的代码快照发生变化');
    if (!s.importing && readdirSync(s.workDir).length)
      throw Error('导入前新题工作区必须为空');
    s.importing = sourceHash;
    this.save(s);
    for (const f of files) {
      const rel = f.name.slice('workspace/'.length);
      const dest = path.resolve(s.workDir, rel),
        src = path.resolve(evidence, f.name);
      if (
        !dest.startsWith(s.workDir + path.sep) ||
        !src.startsWith(evidence + path.sep) ||
        !lstatSync(src).isFile() ||
        lstatSync(src).isSymbolicLink()
      )
        throw Error('代码快照路径无效');
      const data = readFileSync(src);
      if (hash(data) !== f.sha256) throw Error('上一题代码快照哈希不匹配');
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, data, { mode: (f.mode || 0o600) | 0o600 });
      chmodSync(dest, (f.mode || 0o600) | 0o600);
    }
    delete s.importing;
    s.sourceSnapshot = {
      turnId: previous.id,
      manifestPath,
      sha256: hash(manifestBytes),
      files: files.length,
      omitted: manifest.omitted || [],
      importedAt: new Date().toISOString(),
      importedAfterStartup: true,
    };
    this.save(s);
  }
  permissionPreflight(s) {
    this.owned(s);
    if (!s.terminalIdentity?.realTerminal)
      throw Error('缺少实际 Mac Terminal 终端');
    // This does not consume a model prompt or change any model/client configuration.
    const script = `const fs=require('fs'),crypto=require('crypto');let args=null;for(const id of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const a=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\\0');if(a.includes('--dangerously-skip-permissions')){args=a;break;}}catch{}}if(!args)throw Error('Claude 免审批进程不存在');const arg=k=>args[args.indexOf(k)+1];const settings=JSON.parse(arg('--settings')||'{}');const mcp=JSON.parse(arg('--mcp-config')||'{}');const file='/workspace/.permission-check-'+crypto.randomUUID();let writable=false;try{fs.writeFileSync(file,'check',{flag:'wx'});writable=fs.readFileSync(file,'utf8')==='check';}finally{try{fs.unlinkSync(file);}catch{}}console.log(JSON.stringify({skipPermissions:args.includes('--dangerously-skip-permissions'),settingsIsolated:args.includes('--setting-sources')&&arg('--setting-sources')==='',hooksIsolated:args.includes('--safe-mode')&&!settings.hooks&&!settings.permissions?.deny?.length,mcpIsolated:args.includes('--strict-mcp-config')&&Object.keys(mcp.mcpServers||{}).length===0,workspaceWritable:writable,tools:(arg('--tools')||'').split(','),checkedAt:new Date().toISOString()}));`;
    return verifyPermissionPreflight(
      JSON.parse(this.command(['exec', s.containerId, 'node', '-e', script])),
    );
  }
  permissionAudit(traceExport) {
    const manifest = JSON.parse(readFileSync(traceExport.manifestPath, 'utf8'));
    const files = manifest.files
      .filter((f) => f.name.endsWith('.jsonl'))
      .map((f) => ({
        name: f.name,
        content: readFileSync(path.join(traceExport.path, f.name), 'utf8'),
      }));
    return { ...auditPermissionTraces(files), traceSha256: traceExport.sha256 };
  }
  async attach(s, fresh = false) {
    let live = this.live.get(s.taskId);
    if (!live || live.child.exitCode !== null) {
      live = await connectTerminal(s.terminal);
      this.live.set(s.taskId, live);
    }
    s.terminalIdentity = live.identity;
    const child = live.child;
    await nap(2000);
    // Accept only this fixed image's first-run warning after isolation has been verified.
    if (fresh) {
      for (let i = 0; i < 20; i++) {
        const screen = compactTerminal(live.output);
        if (/bypasspermissionson/i.test(screen)) break;
        if (screen.includes('Yes,Iaccept') && screen.includes('No,exit')) {
          this.owned(s);
          await child.stdin.write('\x1b[B');
          await nap(700);
          await child.stdin.write('\r');
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
    if (turn.continuationOf && !turn.repairOf)
      throw Error('仅 Bug 修复允许继续原会话，普通续写已停止');
    const s = await this.ensure(task, turn);
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
      if (Object.keys(s.results).length >= sessionLimits.maxLogicalTurns)
        throw Error('同一会话最多初始题加两轮 Bug 修复');
      if (Object.keys(s.results).length && !turn.repairOf)
        throw Error('非 Bug 题目必须使用新会话');
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
    }
    // Reservation receipts are idempotent. A network failure here happened before
    // terminal input, so recover the same receipt before sending anything.
    if (p.phase === 'reserved') {
      const quota = await reserve(p.attemptId, s.sessionId);
      if (!quota.allowed) {
        delete s.pending;
        this.save(s);
        throw Error('当前会话已达 10 次 Claude 调用上限');
      }
      p.count = quota.count;
      p.phase = 'sent';
      this.save(s);
      const live = this.live.get(task.id);
      await live.child.stdin.write('\x1b[200~' + turn.prompt + '\x1b[201~');
      await nap(500);
      await live.child.stdin.write('\r');
    }
    const progress = new NativeProgressWatch(
      Number(process.env.RUNNER_TIMEOUT_MS || 1800000),
    );
    while (true) {
      if (this.shouldStop())
        throw Error('执行器停止，容器中的当前交互保留；重新连接后核对原始轨迹');
      if (!this.owned(s).State.Running)
        throw Error('容器交互已退出，保留容器供导出；不恢复或重发题目');
      const native = readNativeTurn(this.native(s), turn.prompt, p.previousIds);
      const idle = progress.observe(native);
      if (!native?.complete)
        await this.confirmLocalCommand(s, task, turn, native);
      if (native?.complete) {
        if (s.sessionId && s.sessionId !== native.sessionId)
          throw Error('同一容器的会话 ID 发生变化');
        s.sessionId = native.sessionId;
        s.harnessVersion = native.harnessVersion || s.harnessVersion;
        const traceExport = await this.export(s, turn.id);
        const permissionAudit = this.permissionAudit(traceExport);
        const dir = path.dirname(this.file(task.id)),
          tracePath = path.join(dir, turn.id + '.jsonl');
        writeFileSync(tracePath, native.content, { mode: 0o600 });
        writeFileSync(
          path.join(dir, turn.id + '.native.jsonl'),
          native.nativeContent,
          { mode: 0o600 },
        );
        const result = {
          success: !native.error && permissionAudit.passed,
          output: native.output,
          error: !permissionAudit.passed
            ? '完整会话存在权限拒绝或未确认免审批模式；原始轨迹保留，需新建任务重新采集'
            : native.error
              ? 'Claude 原始轨迹报告调用错误'
              : '',
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
          permissionAudit,
          claudeCallCount: p.count,
          executionOutcome:
            native.error || !permissionAudit.passed ? 'error' : 'complete',
          finishedAt: new Date().toISOString(),
        };
        s.results[turn.id] = result;
        delete s.pending;
        s.traceExport = traceExport;
        s.permissionAudit = permissionAudit;
        await this.publish(s);
        return { ...result, container: this.public(s) };
      }
      if (idle)
        throw Error(
          '本轮长时间没有新的原生执行记录，尚未确认结束；已保留容器和调用额度，重试只核对原交互，不重发题目',
        );
      await nap(1500);
    }
  }
  async confirmLocalCommand(s, task, turn, native) {
    const live = this.live.get(s.taskId);
    if (!live || live.child.exitCode !== null) return;
    const candidate = terminalConfirmation(
      live.output,
      native,
      task.projectSeries?.directory,
    );
    if (!candidate) return;
    const records = (s.terminalConfirmations ||= {});
    if (records[candidate.toolUseId]) return; // Persist-before-input prevents duplicate confirmations on restart.
    const record = (records[candidate.toolUseId] = {
      toolUseId: candidate.toolUseId,
      commandSha256: hash(candidate.command),
      source: 'runner / existing Mac Terminal',
      rule: 'local-compound-command-v1',
      reason: candidate.reason,
      status: candidate.allowed ? 'reserved' : 'needs_review',
      detectedAt: new Date().toISOString(),
    });
    await this.publish(s);
    if (!candidate.allowed) return;
    this.owned(s);
    if (!this.permissionPreflight(s).passed)
      throw Error('确认前权限预检未通过');
    // Re-read both UI and native evidence immediately before selecting the
    // visible first option. Never choose the persistent “don't ask again” item.
    const current = readNativeTurn(
      this.native(s),
      turn.prompt,
      s.pending?.previousIds || [],
    );
    const check = terminalConfirmation(
      live.output,
      current,
      task.projectSeries?.directory,
    );
    if (
      !check?.allowed ||
      check.toolUseId !== candidate.toolUseId ||
      hash(check.command) !== record.commandSha256
    ) {
      record.status = 'screen_changed';
      await this.publish(s);
      return;
    }
    try {
      await live.child.stdin.write('\r');
      record.status = 'confirmed';
      record.confirmedAt = new Date().toISOString();
      record.choice = 'Yes / this command only';
    } catch (e) {
      record.status = 'input_unconfirmed';
      await this.publish(s);
      throw e;
    }
    await this.publish(s);
  }
  async close(taskId) {
    const s = this.load(taskId);
    if (!s || s.status === 'removed') return;
    try {
      if (this.owned(s).State.Running) {
        const assertIdle = () => {
          const current = this.load(taskId);
          if (
            current?.containerId !== s.containerId ||
            current?.questionId !== s.questionId
          )
            throw Error('题目容器已变化，保留原容器');
          return assertNativeSessionIdle(current, this.native(current));
        };
        try {
          assertIdle();
          await this.attach(s);
          const child = this.live.get(taskId).child;
          s.terminalExit = await exitCompletedTerminal({
            readOutput: (cursor) => terminalOutput(s.terminal, cursor),
            write: (data) => child.stdin.write(data),
            isRunning: () => this.owned(s).State.Running,
            assertIdle,
          });
        } catch (e) {
          if (this.owned(s).State.Running) throw e;
          s.terminalExit = { confirmed: true, naturalExitObserved: true };
        }
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
