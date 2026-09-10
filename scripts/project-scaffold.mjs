import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const hash = (x) => createHash('sha256').update(x).digest('hex');

// Compile in memory without importing or executing generated project code.
// Invalid fixtures must never become the frozen initial environment.
export function validateScaffoldSyntax(files, { containerId } = {}) {
  const python = files.filter((file) => file.path.endsWith('.py'));
  if (!python.length) return;
  if (containerId && !/^[a-f0-9]{64}$/.test(containerId))
    throw Error('骨架语法检查的容器标识无效');
  let issues;
  try {
    issues = JSON.parse(
      execFileSync(
        containerId ? 'docker' : 'python3',
        [
          ...(containerId ? ['exec', '-i', containerId, 'python3'] : []),
          '-I',
          '-c',
          'import json,sys\nissues=[]\nfor f in json.load(sys.stdin):\n try: compile(f["content"], f["path"], "exec", dont_inherit=True)\n except (SyntaxError, ValueError) as e: issues.append({"path":f["path"],"line":getattr(e,"lineno",None),"message":str(getattr(e,"msg",e))})\nprint(json.dumps(issues))',
        ],
        {
          input: JSON.stringify(python),
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 256 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ),
    );
  } catch {
    throw Error('无法完成 Python 骨架语法检查，请确认目标环境 python3 可用');
  }
  if (issues.length)
    throw Error(
      '骨架 Python 语法错误：' +
        issues.map((e) => `${e.path}:${e.line || '?'} ${e.message}`).join('；'),
    );
}
export function validateScaffold(value) {
  if (
    ['stack', 'summary', 'startup'].some(
      (k) =>
        typeof value?.[k] !== 'string' ||
        !value[k].trim() ||
        value[k].length > 4000,
    )
  )
    throw Error('骨架技术栈、说明或启动方式无效');
  if (
    !value ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 40
  )
    throw Error('项目骨架需包含 1–40 个文件');
  const names = new Set();
  let bytes = 0;
  for (const file of value.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.length > 240 ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((s) => !s || s === '.' || s === '..') ||
      /(^|\/)(\.claude|\.codex|\.git|\.env[^/]*|AGENTS\.md|CLAUDE\.md|[^/]*\.(pem|key|p12))($|\/)/i.test(
        file.path,
      ) ||
      names.has(file.path)
    )
      throw Error('骨架文件路径无效或包含配置/凭据文件');
    if (
      typeof file.content !== 'string' ||
      Buffer.byteLength(file.content) > 32000 ||
      typeof file.executable !== 'boolean'
    )
      throw Error('骨架文件内容无效或过大');
    names.add(file.path);
    bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 160000)
    throw Error('骨架总内容超过 160KB，不能预先生成完整业务实现');
  return value;
}
export function installScaffold({
  value,
  workDir,
  directory,
  evidenceDir,
  tracePath,
  pythonContainerId,
}) {
  validateScaffold(value);
  validateScaffoldSyntax(value.files, { containerId: pythonContainerId });
  if (!/^projects\/p-[a-f0-9-]{36}$/.test(directory))
    throw Error('骨架项目目录无效');
  const root = path.join(workDir, directory);
  mkdirSync(root, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const files = value.files.map((file) => ({
    ...file,
    sha256: hash(file.content),
  }));
  const manifest = {
    version: '2026-09-09.scaffold1',
    generatedBy: 'Codex CLI',
    purpose: '项目骨架与通用配置，不包含被测业务实现',
    directory,
    stack: value.stack,
    startup: value.startup,
    tracePath,
    files,
  };
  const manifestPath = path.join(evidenceDir, 'manifest.json'),
    data = JSON.stringify(manifest, null, 2);
  if (existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') !== data)
    throw Error('已冻结的骨架发生变化');
  writeFileSync(manifestPath, data, { mode: 0o600 });
  for (const file of files) {
    const dest = path.resolve(root, file.path);
    if (!dest.startsWith(root + path.sep)) throw Error('骨架目录越界');
    mkdirSync(path.dirname(dest), { recursive: true });
    if (
      existsSync(dest) &&
      (!lstatSync(dest).isFile() ||
        lstatSync(dest).isSymbolicLink() ||
        hash(readFileSync(dest)) !== file.sha256)
    )
      throw Error('不能覆盖已变化的项目文件');
    writeFileSync(dest, file.content, {
      mode: file.executable ? 0o755 : 0o644,
    });
    chmodSync(dest, file.executable ? 0o755 : 0o644);
  }
  return {
    manifestPath,
    sha256: hash(data),
    files: files.length,
    generatedBy: 'Codex CLI',
    importedAfterStartup: true,
    stack: value.stack,
  };
}
