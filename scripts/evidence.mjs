import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export function verifyScoreEvidence(value, workDir, dir) {
  const roots = [realpathSync(workDir), realpathSync(dir)];
  const descriptions = [];
  for (let i = 0; i < 5; i++) {
    const ref = value.evidenceRefs[i],
      match = ref.match(/^(.*):(\d+)$/);
    if (!match) throw Error('评分证据必须包含文件路径和行号：' + ref);
    const file = realpathSync(path.resolve(workDir, match[1]));
    if (!roots.some((root) => file.startsWith(root + path.sep)))
      throw Error('评分证据超出任务工作区');
    const line = Number(match[2]),
      total = readFileSync(file, 'utf8').split('\n').length;
    if (line < 1 || line > total) throw Error('评分引用行号不存在：' + ref);
    descriptions.push(
      `触发节点：${value.when[i]}；实际行为：${value.behavior[i]}；影响：${value.impact[i]}；正确做法：${value.expected[i]}；证据：${file}:${line}。${(value.rawDescriptions || value.descriptions)[i]}`,
    );
  }
  return {
    ...value,
    rawDescriptions: value.rawDescriptions || value.descriptions,
    descriptions,
    evidenceVerified: true,
  };
}
export function createEvidenceArchive({
  dir,
  turnId,
  bundlePath,
  tracePath,
  automation,
  workDir,
}) {
  const stageDir = path.join(dir, turnId + '.evidence');
  mkdirSync(stageDir, { recursive: true });
  const manifest = [];
  function add(src, name) {
    if (!existsSync(src)) throw Error('交付证据缺失：' + src);
    const data = readFileSync(src);
    mkdirSync(path.dirname(path.join(stageDir, name)), { recursive: true });
    writeFileSync(path.join(stageDir, name), data, { mode: 0o600 });
    manifest.push({
      name,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  add(bundlePath, 'evaluation.json');
  add(tracePath, 'claude.jsonl');
  const native = path.join(dir, turnId + '.native.jsonl');
  if (existsSync(native)) add(native, 'claude-native.jsonl');
  for (const [key, value] of Object.entries(automation))
    if (value?.tracePath) add(value.tracePath, key + '.jsonl');
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(path.join(stageDir, 'tracked-changes.patch'), diff, {
    mode: 0o600,
  });
  manifest.push({
    name: 'tracked-changes.patch',
    bytes: Buffer.byteLength(diff),
    sha256: createHash('sha256').update(diff).digest('hex'),
  });
  const omitted = [];
  let total = 0;
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter(Boolean);
  for (const name of untracked) {
    const src = path.resolve(workDir, name),
      rel = path.relative(workDir, src);
    if (src.startsWith(stageDir + path.sep)) continue;
    const info = lstatSync(src);
    if (
      rel.startsWith('..') ||
      path.isAbsolute(rel) ||
      !info.isFile() ||
      /(^|\/)(\.env[^/]*|\.claude|\.codex|credentials[^/]*|[^/]*\.(pem|key|p12))($|\/)/i.test(
        rel,
      ) ||
      info.size > 10 * 1024 * 1024 ||
      total + info.size > 32 * 1024 * 1024
    ) {
      omitted.push({ name, reason: '路径、敏感文件类型或归档大小限制' });
      continue;
    }
    add(src, 'untracked/' + rel);
    total += info.size;
  }
  writeFileSync(
    path.join(stageDir, 'manifest.json'),
    JSON.stringify(
      {
        format: 1,
        provenance: 'AI evaluation',
        files: manifest,
        omitted,
        note: '本地证据包包含轨迹、评估、已跟踪 diff 和符合大小限制的未跟踪普通文件。排除项列入 omitted；使用前核对，未向外部上传。',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const archivePath = path.join(dir, turnId + '.evidence.tar.gz');
  execFileSync(
    'tar',
    [
      '-czf',
      archivePath,
      '-C',
      stageDir,
      ...manifest.map((f) => f.name),
      'manifest.json',
    ],
    { timeout: 60000 },
  );
  return {
    archivePath,
    sha256: createHash('sha256')
      .update(readFileSync(archivePath))
      .digest('hex'),
    files: manifest.length + 1,
  };
}
