import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export function verifyScoreEvidence(value, workDir, dir) {
  const roots = [realpathSync(workDir), realpathSync(dir)];
  for (let i = 0; i < 5; i++) {
    const ref = value.evidenceRefs[i],
      match = ref.match(/^(.*):(\d+)$/);
    if (!match) throw Error('评分证据必须包含文件路径和行号：' + ref);
    const file = realpathSync(path.resolve(workDir, match[1]));
    if (!roots.some((root) => file.startsWith(root + path.sep)))
      throw Error('评分证据超出任务工作区');
    if (lstatSync(file).size > 10 * 1024 * 1024)
      throw Error('单个评分证据超过 10MB，请引用更小的可核验文件');
    const line = Number(match[2]),
      total = readFileSync(file, 'utf8').split('\n').length;
    if (line < 1 || line > total) throw Error('评分引用行号不存在：' + ref);
  }
  return {
    ...value,
    rawDescriptions: value.rawDescriptions || value.descriptions,
    descriptions: value.descriptions,
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
  for (const [key, value] of Object.entries(automation)) {
    if (value?.tracePath) add(value.tracePath, key + '.jsonl');
    if (value?.writingRevision?.originalTracePath)
      add(
        value.writingRevision.originalTracePath,
        key + '.before-writing.jsonl',
      );
  }
  // Freeze every cited file before any later Claude round changes the workspace.
  const citations = [],
    captured = new Map();
  let citedBytes = 0;
  for (const [i, ref] of (
    automation.score?.value?.evidenceRefs || []
  ).entries()) {
    const match = ref.match(/^(.*):(\d+)$/);
    if (!match) throw Error('评分引用格式无效');
    const file = realpathSync(path.resolve(workDir, match[1]));
    if (
      ![realpathSync(workDir), realpathSync(dir)].some((root) =>
        file.startsWith(root + path.sep),
      )
    )
      throw Error('引用超出工作区');
    const bytes = lstatSync(file).size;
    let name = captured.get(file);
    if (!name) {
      if (bytes > 10 * 1024 * 1024 || citedBytes + bytes > 32 * 1024 * 1024)
        throw Error('评分引用文件超过归档上限');
      name = 'cited/' + i + '.txt';
      add(file, name);
      captured.set(file, name);
      citedBytes += bytes;
    }
    citations.push({
      ref,
      name,
      line: Number(match[2]),
      sha256: manifest.find((f) => f.name === name).sha256,
    });
  }
  let diff = '';
  // A fresh /workspace is intentionally not a Git checkout. Never initialize it for bookkeeping.
  if (existsSync(path.join(workDir, '.git'))) {
    try {
      diff = execFileSync('git', ['diff', '--binary', 'HEAD'], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      diff = 'Git HEAD 不可用；产物文件按本轮结束时的实际内容归档。\n';
    }
  } else diff = '初始环境为空目录；产物文件按本轮结束时的实际内容归档。\n';
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
  const excluded =
    /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|\.next)($|\/)/;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const src = path.join(dir, e.name),
        rel = path.relative(workDir, src);
      if (excluded.test(rel)) {
        omitted.push({
          name: rel,
          reason: '版本库内部文件或可重新安装的依赖/缓存',
        });
        return [];
      }
      return e.isDirectory() ? walk(src) : [rel];
    });
  const untracked = walk(workDir);
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
    add(src, 'workspace/' + rel);
    total += info.size;
  }
  writeFileSync(
    path.join(stageDir, 'manifest.json'),
    JSON.stringify(
      {
        format: 3,
        provenance: 'AI evaluation',
        files: manifest,
        citations,
        omitted,
        note: '本地证据包包含轨迹、评估、可用的 Git diff 和符合大小限制的完整工作区普通文件。排除项列入 omitted；使用前核对，未向外部上传。',
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

// Stable excerpts from the finished round's archive staging, never the later working tree.
export function reviewEvidence({ dir, turnId, tracePath }) {
  const stageDir = path.join(dir, turnId + '.evidence');
  const manifest = JSON.parse(
    readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'),
  );
  const items = [];
  for (const [id, label, name, limit, originalPath] of [
    ['trace', '本轮执行轨迹', 'claude.jsonl', 24000, tracePath],
    [
      'diff',
      '本轮结束时相对初始快照的累计代码变更',
      'tracked-changes.patch',
      16000,
      path.join(stageDir, 'tracked-changes.patch'),
    ],
  ]) {
    const full = readFileSync(path.join(stageDir, name), 'utf8');
    let content = full.slice(0, limit);
    if (full.length > limit && content.lastIndexOf('\n') > 0)
      content = content.slice(0, content.lastIndexOf('\n'));
    items.push({
      id,
      label,
      content,
      originalPath,
      sha256: manifest.files.find((f) => f.name === name)?.sha256,
      truncated: full.length > limit,
    });
  }
  for (const [i, citation] of (manifest.citations || []).entries()) {
    const lines = readFileSync(
      path.join(stageDir, citation.name),
      'utf8',
    ).split('\n');
    const start = Math.max(0, citation.line - 4),
      end = Math.min(lines.length, citation.line + 3);
    const full = lines
      .slice(start, end)
      .map((s, n) => `${start + n + 1}: ${s}`)
      .join('\n');
    items.push({
      id: 'cite_' + i,
      label: '评分时的证据原文 · ' + citation.ref,
      originalRef: citation.ref,
      originalPath: path.join(stageDir, citation.name),
      sha256: citation.sha256,
      content: full.slice(0, 4800),
      truncated: true,
    });
  }
  items.push({
    id: 'manifest',
    label: '归档文件与排除项',
    content: JSON.stringify(manifest, null, 2).slice(0, 16000),
    truncated: JSON.stringify(manifest, null, 2).length > 16000,
  });
  while (JSON.stringify(items).length > 60000) {
    const longest = items.reduce((a, b) =>
      a.content.length > b.content.length ? a : b,
    );
    longest.content = longest.content.slice(
      0,
      Math.floor(longest.content.length / 2),
    );
    longest.truncated = true;
  }
  return items;
}
