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
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const hashFile = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
export function evidenceRelativeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    path.isAbsolute(name) ||
    name.includes('\\') ||
    name
      .split('')
      .some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw Error('证据清单路径无效');
  return name;
}
export function evidencePath(file, root, directory = false) {
  const base = path.resolve(root),
    absolute = path.resolve(file);
  if (!absolute.startsWith(base + path.sep)) throw Error('证据超出任务目录');
  let current = base;
  if (lstatSync(current).isSymbolicLink())
    throw Error('证据目录不能是符号链接');
  for (const part of path.relative(base, absolute).split(path.sep)) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw Error('证据路径不能是符号链接');
  }
  const stat = lstatSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile())
    throw Error('证据文件类型无效');
  return absolute;
}
export function evidenceInventory(root) {
  const files = [],
    directories = [];
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
    throw Error('证据目录类型无效');
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const file = path.join(dir, entry),
        name = evidenceRelativeName(path.relative(root, file));
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('证据目录不能含符号链接');
      if (stat.isDirectory()) {
        directories.push(name);
        walk(file);
      } else if (stat.isFile())
        files.push({ name, bytes: stat.size, sha256: hashFile(file) });
      else throw Error('证据目录含非普通文件');
    }
  }
  walk(root);
  return {
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
    directories: directories.sort((a, b) => a.localeCompare(b)),
  };
}
export function readVerifiedTraceExport(
  traceExport,
  dir,
  { allowEmpty = false } = {},
) {
  if (
    !traceExport?.verified ||
    !/^[a-f0-9]{64}$/.test(traceExport.sha256 || '')
  )
    throw Error('完整原生轨迹缺少已验真回执');
  const root = evidencePath(traceExport.path, dir, true);
  const manifestPath = evidencePath(traceExport.manifestPath, dir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = manifest.files;
  if (
    !Array.isArray(files) ||
    (!allowEmpty && !files.length) ||
    traceExport.files !== files.length ||
    createHash('sha256').update(JSON.stringify(files)).digest('hex') !==
      traceExport.sha256
  )
    throw Error('完整原生轨迹清单摘要不符');
  const seen = new Set();
  for (const file of files) {
    evidenceRelativeName(file.name);
    if (
      seen.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || '')
    )
      throw Error('完整原生轨迹清单字段无效或重复');
    seen.add(file.name);
  }
  const observed = evidenceInventory(root);
  const expected = files
    .map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(observed.files) !== JSON.stringify(expected))
    throw Error('完整原生轨迹文件集合、大小或摘要不符');
  return {
    root,
    manifestPath,
    manifestSha256: hashFile(manifestPath),
    sha256: traceExport.sha256,
    containerId: manifest.containerId,
    ...observed,
  };
}
export function verifyNativeExport(
  traceExport,
  { dir, containerId, allowEmpty = false } = {},
) {
  const verified = readVerifiedTraceExport(traceExport, dir, { allowEmpty });
  if (containerId !== undefined && verified.containerId !== containerId)
    throw Error('完整原生轨迹与容器身份不符');
  return verified;
}
export function scoreEvidenceInstructions(workDir, dir) {
  return `评分引用路径：本阶段工作目录是 ${JSON.stringify(path.resolve(workDir))}，本任务证据目录是 ${JSON.stringify(path.resolve(dir))}。evidenceRefs 使用实际读取文件的绝对路径:行号，空格原样保留，不加引号或 Markdown，不用 basename 或猜测 ../ 层数。原始轨迹、运行日志和冻结索引已提供绝对路径，直接引用对应原文件；源码路径从本阶段工作目录定位。返回前逐个只读确认文件存在、行号对应引用内容。历史相对路径只按本阶段工作目录解析，不按任务目录、项目子目录、输出 JSON 或日志所在目录解析；不能复制旧路径而忽略目录层级。找不到证据时说明实际缺失，不创建文件、符号链接、复制品或改动原件来满足引用。`;
}
function scoreCitations(refs, workDir, dir) {
  if (!Array.isArray(refs) || refs.length !== 5)
    throw Error('评分证据须按五维提供 5 组引用');
  const roots = [realpathSync(workDir), realpathSync(dir)];
  const citations = [],
    totals = new Map();
  for (const [dimension, group] of refs.entries()) {
    const entries =
      typeof group === 'string'
        ? group.split(/[;；\n]/).map((s) => s.trim())
        : [];
    if (!entries.length || entries.length > 8 || entries.some((s) => !s))
      throw Error('每维评分证据须提供 1–8 个引用，多个引用用分号分隔');
    for (const ref of entries) {
      const match = ref.match(/^(.*):(\d+)$/);
      if (!match) throw Error('评分证据必须包含文件路径和行号：' + ref);
      const resolved = path.resolve(workDir, match[1]);
      if (!existsSync(resolved))
        throw Error(
          '评分引用文件不存在（相对路径按评分工作目录解析）：' + resolved,
        );
      const file = realpathSync(resolved);
      if (!roots.some((root) => file.startsWith(root + path.sep)))
        throw Error('评分证据超出任务工作区');
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
        throw Error('评分证据须为不超过 10MB 的普通文件');
      if (!totals.has(file))
        totals.set(file, readFileSync(file, 'utf8').split('\n').length);
      const line = Number(match[2]);
      if (!Number.isSafeInteger(line) || line < 1 || line > totals.get(file))
        throw Error('评分引用行号不存在：' + ref);
      citations.push({ dimension, ref, file, line });
    }
  }
  return citations;
}
export function verifyScoreEvidence(value, workDir, dir) {
  scoreCitations(value.evidenceRefs, workDir, dir);
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
  traceExport,
}) {
  const baseDir = path.join(dir, turnId + '.evidence');
  const stageDir =
    existsSync(baseDir) || existsSync(baseDir + '.tar.gz')
      ? baseDir + '-' + randomUUID()
      : baseDir;
  mkdirSync(stageDir, { mode: 0o700 });
  const manifest = [];
  const names = new Set();
  function add(src, name, expectedSha256) {
    evidenceRelativeName(name);
    if (names.has(name)) throw Error('交付证据目标路径重复');
    names.add(name);
    if (!existsSync(src)) throw Error('交付证据缺失：' + src);
    const data = readFileSync(src);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (expectedSha256 !== undefined && sha256 !== expectedSha256)
      throw Error('交付证据摘要不一致：' + name);
    mkdirSync(path.dirname(path.join(stageDir, name)), { recursive: true });
    writeFileSync(path.join(stageDir, name), data, { mode: 0o600, flag: 'wx' });
    manifest.push({
      name,
      mode: lstatSync(src).mode & 0o777,
      bytes: data.length,
      sha256,
    });
  }
  function addRuntimeEvidence(src, name, sha256, alreadyAdded = false) {
    if (
      typeof src !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256 || '') ||
      !existsSync(src) ||
      !lstatSync(src).isFile() ||
      !realpathSync(src).startsWith(realpathSync(dir) + path.sep)
    )
      throw Error('独立验收附加证据无效：' + name);
    if (alreadyAdded) {
      if (hashFile(src) !== sha256) throw Error('交付证据摘要不一致：' + name);
      return;
    }
    // Hash the same bytes that are copied; never rewrite the original log/view.
    add(src, name, sha256);
  }
  add(bundlePath, 'evaluation.json');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const container = bundle.container;
  const nativeExport = traceExport || bundle.traceExport;
  let nativeEvidence = null;
  if (nativeExport) {
    if (bundle.traceExport && bundle.traceExport.sha256 !== nativeExport.sha256)
      throw Error('完整原生轨迹与本轮评测回执不符');
    nativeEvidence = verifyNativeExport(nativeExport, {
      dir,
      containerId: container?.containerId,
    });
    add(
      nativeEvidence.manifestPath,
      'native/manifest.json',
      nativeEvidence.manifestSha256,
    );
    mkdirSync(path.join(stageDir, 'native/projects'), { recursive: true });
    for (const name of nativeEvidence.directories)
      mkdirSync(path.join(stageDir, 'native/projects', name), {
        recursive: true,
      });
    for (const file of nativeEvidence.files)
      add(
        path.join(nativeEvidence.root, file.name),
        'native/projects/' + file.name,
        file.sha256,
      );
  }
  if (container?.scaffoldSnapshot) {
    const initial = container.scaffoldSnapshot;
    const data = readFileSync(initial.manifestPath);
    if (createHash('sha256').update(data).digest('hex') !== initial.sha256)
      throw Error('Initial scaffold hash mismatch');
    add(initial.manifestPath, 'initial-scaffold.json');
  }
  if (container?.sourceSnapshot) {
    const initial = container.sourceSnapshot;
    const data = readFileSync(initial.manifestPath);
    if (createHash('sha256').update(data).digest('hex') !== initial.sha256)
      throw Error('Initial source manifest hash mismatch');
    add(initial.manifestPath, 'initial-source-manifest.json');
    const base = path.dirname(initial.manifestPath);
    for (const f of JSON.parse(data).files.filter((f) =>
      f.name.startsWith('workspace/'),
    )) {
      const src = path.resolve(base, f.name);
      if (
        !src.startsWith(base + path.sep) ||
        !lstatSync(src).isFile() ||
        lstatSync(src).isSymbolicLink() ||
        createHash('sha256').update(readFileSync(src)).digest('hex') !==
          f.sha256
      )
        throw Error('Initial source file hash mismatch');
      add(src, 'initial-workspace/' + f.name.slice('workspace/'.length));
    }
  }
  add(tracePath, 'claude.jsonl');
  const runtime = automation.runtimeVerification;
  if (runtime) {
    if (hashFile(runtime.reportPath) !== runtime.reportSha256)
      throw Error('独立验收报告摘要不一致');
    add(runtime.reportPath, 'runtime/report.json');
    add(runtime.executionPath, 'runtime/execution.json');
    if (runtime.regressionContext) {
      const seen = new Set();
      for (const c of runtime.regressionContext.checks) {
        for (const [file, sha256, extension] of [
          [c.sourceReportPath, c.sourceReportSha256, 'report.json'],
          [c.sourceLogPath, c.sourceLogSha256, 'log'],
        ]) {
          const name = 'runtime/regression-history/' + sha256 + '.' + extension;
          // Validate each reference even when another check shares its content.
          addRuntimeEvidence(file, name, sha256, seen.has(name));
          seen.add(name);
        }
      }
    }
    for (const c of runtime.checks) {
      if (hashFile(c.logPath) !== c.logSha256)
        throw Error('独立验收日志摘要不一致');
      add(c.logPath, 'runtime/' + c.id + '.log');
    }
    if (runtime.environmentProbe) {
      const probe = runtime.environmentProbe;
      addRuntimeEvidence(
        probe.logPath,
        'runtime/environment-probe.log',
        probe.logSha256,
      );
      if (probe.browserCache) {
        const cache = probe.browserCache;
        for (const [file, sha256, name] of [
          [cache.recordPath, cache.recordSha256, 'usage.json'],
          [cache.manifestPath, cache.manifestSha256, 'ready.json'],
          [cache.buildLogPath, cache.buildLogSha256, 'build.log'],
        ])
          addRuntimeEvidence(file, 'runtime/browser-cache/' + name, sha256);
      }
    }
    if (runtime.diagnosisEvidence) {
      const { logs } = runtime.diagnosisEvidence;
      if (!Array.isArray(logs) || logs.length !== runtime.checks.length)
        throw Error('诊断行号证据与验收日志数量不符');
      const seen = new Set();
      for (const item of logs) {
        const check = runtime.checks.find((c) => c.id === item.id);
        if (
          !check ||
          seen.has(item.id) ||
          !/^[a-z][a-z0-9_-]{0,127}$/.test(item.id) ||
          item.logPath !== check.logPath ||
          item.logSha256 !== check.logSha256
        )
          throw Error('诊断行号证据与原始验收日志不符');
        seen.add(item.id);
        addRuntimeEvidence(
          item.numberedPath,
          'runtime/diagnosis-evidence/' + item.id + '.lines.jsonl',
          item.numberedSha256,
        );
      }
    }
    add(runtime.plan.tracePath, 'runtime/plan.jsonl');
    add(runtime.diagnosis.tracePath, 'runtime/diagnosis.jsonl');
  }
  if (automation.scoreRetryContext) {
    const expected = new Map([
      ['previous-score.json', 'score.json'],
      ['previous-score.events.jsonl', 'score.events.jsonl'],
      ['previous-delivery.json', 'delivery.json'],
      ['previous-delivery.events.jsonl', 'delivery.events.jsonl'],
    ]);
    const artifacts = automation.scoreRetryContext.artifacts;
    if (!Array.isArray(artifacts) || artifacts.length !== expected.size)
      throw Error('评分重试证据必须包含四份完整审核附件');
    const seen = new Set();
    const escapedTurnId = turnId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const artifact of artifacts) {
      const suffix = expected.get(artifact?.name);
      if (
        !suffix ||
        seen.has(artifact.name) ||
        typeof artifact.path !== 'string'
      )
        throw Error('评分重试附件名称无效或重复');
      seen.add(artifact.name);
      const relative = path.relative(
        path.resolve(dir),
        path.resolve(artifact.path),
      );
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw Error('评分重试附件必须位于本任务目录');
      // Never package a private runner receipt, including a receipt disguised
      // behind a symlink or an attachment name that says it is a score.
      let component = path.resolve(dir);
      for (const part of relative.split(path.sep)) {
        component = path.join(component, part);
        if (
          part.endsWith('.result.json') ||
          lstatSync(component).isSymbolicLink()
        )
          throw Error('评分重试附件不能引用私有回执或符号链接');
      }
      const sourceName = new RegExp(
        '^' +
          escapedTurnId +
          '\\.attempt-[1-9]\\d*(?:\\.consistency)?(?:\\.writing)?\\.' +
          suffix.replaceAll('.', '\\.') +
          '$',
      );
      if (
        !sourceName.test(path.basename(artifact.path)) ||
        !sourceName.test(path.basename(realpathSync(artifact.path)))
      )
        throw Error('评分重试附件与当前轮次或审核类型不匹配');
      addRuntimeEvidence(
        artifact.path,
        'score-retry/' + artifact.name,
        artifact.sha256,
      );
    }
  }
  const native = path.join(dir, turnId + '.native.jsonl');
  if (existsSync(native)) add(native, 'claude-native.jsonl');
  for (const [key, value] of Object.entries(automation)) {
    if (key === 'scoreRetryContext') continue;
    if (value?.tracePath) add(value.tracePath, key + '.jsonl');
    if (value?.writingRevision?.originalTracePath)
      add(
        value.writingRevision.originalTracePath,
        key + '.before-writing.jsonl',
      );
    for (const [i, trace] of (
      value?.consistencyRevision?.originalTracePaths || []
    ).entries()) {
      add(trace, `${key}.before-consistency-${i}.jsonl`);
      add(
        trace.slice(0, -'.events.jsonl'.length) + '.json',
        `${key}.before-consistency-${i}.json`,
      );
    }
  }
  // Freeze every cited file before any later Claude round changes the workspace.
  const citations = [],
    captured = new Map();
  let citedBytes = 0;
  const refs = automation.score?.value?.evidenceRefs;
  for (const { dimension, ref, file, line } of refs
    ? scoreCitations(refs, workDir, dir)
    : []) {
    const bytes = lstatSync(file).size;
    let name = captured.get(file);
    if (!name) {
      if (bytes > 10 * 1024 * 1024 || citedBytes + bytes > 32 * 1024 * 1024)
        throw Error('评分引用文件超过归档上限');
      name = 'cited/' + captured.size + '.txt';
      add(file, name);
      captured.set(file, name);
      citedBytes += bytes;
    }
    citations.push({
      ref,
      dimension,
      name,
      line,
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
    const sensitive =
      /(^|\/)(\.env[^/]*|\.claude|\.codex|credentials[^/]*|[^/]*\.(pem|key|p12))($|\/)/i.test(
        rel,
      );
    let reason;
    if (rel.startsWith('..') || path.isAbsolute(rel) || !info.isFile())
      reason = '非普通文件或无效路径';
    else if (sensitive) reason = '敏感配置文件';
    else if (
      info.size > 10 * 1024 * 1024 ||
      total + info.size > 32 * 1024 * 1024
    )
      reason = '代码归档大小限制';
    if (reason) {
      omitted.push({ name, reason });
      continue;
    }
    add(src, 'workspace/' + rel);
    total += info.size;
  }
  writeFileSync(
    path.join(stageDir, 'manifest.json'),
    JSON.stringify(
      {
        format: 4,
        provenance: 'AI evaluation',
        files: manifest,
        citations,
        omitted,
        ...(nativeEvidence
          ? {
              nativeTrace: {
                sha256: nativeEvidence.sha256,
                manifestSha256: nativeEvidence.manifestSha256,
                files: nativeEvidence.files.length,
                prefix: 'native/projects/',
                directories: nativeEvidence.directories,
              },
            }
          : {}),
        note: '本地证据包包含轨迹、评估、可用的 Git diff 和符合大小限制的完整工作区普通文件。排除项列入 omitted；使用前核对，未向外部上传。',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  if (
    nativeEvidence &&
    JSON.stringify(readVerifiedTraceExport(nativeExport, dir)) !==
      JSON.stringify(nativeEvidence)
  )
    throw Error('完整原生轨迹在归档期间发生变化');
  const archivePath = stageDir + '.tar.gz';
  execFileSync(
    'tar',
    [
      '-czf',
      archivePath,
      '-C',
      stageDir,
      '--',
      ...manifest
        .map((f) => f.name)
        .filter((name) => !name.startsWith('native/projects/')),
      ...(nativeEvidence ? ['native/projects'] : []),
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
    stageDir,
    manifestPath: path.join(stageDir, 'manifest.json'),
    manifestSha256: hashFile(path.join(stageDir, 'manifest.json')),
  };
}

// Stable excerpts from the finished round's archive staging, never the later working tree.
export function reviewEvidence({ dir, turnId, tracePath, archive }) {
  const stageDir = archive?.manifestPath
    ? path.dirname(evidencePath(archive.manifestPath, dir))
    : path.join(dir, turnId + '.evidence');
  const manifest = JSON.parse(
    readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'),
  );
  const items = [];
  if (existsSync(path.join(stageDir, 'runtime/report.json'))) {
    const full = readFileSync(
      path.join(stageDir, 'runtime/report.json'),
      'utf8',
    );
    items.push({
      id: 'runtime',
      label: '独立运行验收与复现证据',
      content: full.slice(0, 16000),
      truncated: full.length > 16000,
      originalPath: path.join(stageDir, 'runtime/report.json'),
    });
  }
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
