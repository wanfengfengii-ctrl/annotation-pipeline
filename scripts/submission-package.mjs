import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import { zipSync, unzipSync } from 'fflate';
import {
  evidencePath,
  evidenceRelativeName,
  evidenceInventory,
  verifyNativeExport,
} from './evidence.mjs';
import {
  sanitizeSensitiveText,
  sensitiveContentVersion,
} from '../lib/sensitive-content.mjs';
import { verifyTerminalFinalization } from './terminal-finalization.mjs';
import { isSqlite, scanSqliteContent } from './sqlite-content-scan.mjs';
import { internalContentWarnings } from '../lib/submission-policy.mjs';

export const submissionPackageVersion = '2026-09-10.submission2';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const binaryExtension =
  /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|7z|woff2?|ttf|otf|mp[34]|wav|mov|sqlite3?|db|wasm|exe|dll|so|dylib|bin|p12)$/i;
function validStructuredText(name, text) {
  if (/\.json$/i.test(name)) JSON.parse(text.replace(/^\uFEFF/, ''));
  if (/\.jsonl$/i.test(name))
    for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
}
function redactionCounts(findings) {
  const counts = {};
  for (const { kind } of findings) counts[kind] = (counts[kind] || 0) + 1;
  return Object.entries(counts).map(([kind, count]) => ({ kind, count }));
}
function sanitizePackageText(name, text, knownSecrets) {
  if (!/\.jsonl$/i.test(name))
    return sanitizeSensitiveText(text, { knownSecrets });
  const findings = [];
  const lines = text.split('\n').map((line, index) => {
    const result = sanitizeSensitiveText(line, { knownSecrets });
    findings.push(
      ...result.findings.map((finding) => ({
        ...finding,
        line: index + finding.line,
      })),
    );
    return result.text;
  });
  return {
    text: lines.join('\n'),
    findings,
    changed: lines.join('\n') !== text,
  };
}

function verifiedFinalization(finalization, { dir, identity, terminal }) {
  if (!finalization || !identity?.questionId || !identity.containerId)
    throw Error('提交副本缺少最终终端身份回执');
  const receiptPath = evidencePath(finalization.receiptPath, dir);
  const directory = path.dirname(receiptPath);
  const fresh = verifyTerminalFinalization({
    taskDir: dir,
    questionId: identity.questionId,
    terminal: terminal || {
      runId: identity.runId,
      statePath: path.join(directory, 'state.json'),
      launchPath: path.join(directory, 'question.command'),
    },
  });
  if (
    !fresh ||
    !isDeepStrictEqual(fresh, finalization) ||
    fresh.taskId !== identity.taskId ||
    fresh.questionId !== identity.questionId ||
    fresh.containerId !== identity.containerId ||
    fresh.runId !== identity.runId ||
    (fresh.sessionId &&
      identity.sessionId &&
      fresh.sessionId !== identity.sessionId) ||
    fresh.receiptPath !== receiptPath
  )
    throw Error('提交副本最终终端回执或题目容器身份不符');
  if (fresh.commandTransport === 'original-mac-terminal') {
    const state = JSON.parse(
      readFileSync(
        evidencePath(path.join(directory, 'state.json'), dir),
        'utf8',
      ),
    );
    if (
      state.runId !== fresh.runId ||
      state.containerId !== fresh.containerId ||
      state.status !== 'exited' ||
      state.postprocessingComplete !== true ||
      state.verifiedExport !== true ||
      state.containerRemoved !== true
    )
      throw Error('原终端导出后处理尚未完整结束');
  }
  return fresh;
}

// Submission files are separate derivatives. Original evidence, source files,
// and earlier packages are never modified or relabelled as sanitized.
export function createSubmissionPackage({
  dir,
  turnId,
  archive,
  traceExport,
  finalization,
  knownSecrets = [],
}) {
  evidenceRelativeName(turnId);
  const sourceArchivePath = evidencePath(archive?.archivePath, dir);
  if (
    !/^[a-f0-9]{64}$/.test(archive.sha256 || '') ||
    hash(readFileSync(sourceArchivePath)) !== archive.sha256
  )
    throw Error('提交副本缺少完整的原件归档摘要');
  const sourceManifestPath = evidencePath(
    archive.manifestPath ||
      path.join(dir, turnId + '.evidence', 'manifest.json'),
    dir,
  );
  const sourceRoot = path.dirname(sourceManifestPath);
  const manifestBytes = readFileSync(sourceManifestPath);
  if (archive.manifestSha256 && hash(manifestBytes) !== archive.manifestSha256)
    throw Error('提交副本原件清单已变化');
  const sourceManifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!Array.isArray(sourceManifest.files)) throw Error('提交副本原件清单无效');
  const seen = new Set(),
    inputs = new Map();
  for (const file of sourceManifest.files) {
    evidenceRelativeName(file.name);
    if (
      seen.has(file.name) ||
      file.name === 'manifest.json' ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256 || '')
    )
      throw Error('提交副本原件清单字段无效或重复');
    seen.add(file.name);
    const src = evidencePath(path.join(sourceRoot, file.name), dir);
    const bytes = readFileSync(src);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw Error('提交副本原件文件大小或摘要不符');
    inputs.set(file.name, {
      bytes,
      originalSha256: file.sha256,
      source: 'evidence-archive',
    });
  }
  const observed = evidenceInventory(sourceRoot);
  if (
    JSON.stringify(
      observed.files
        .map((file) => file.name)
        .sort((a, b) => a.localeCompare(b)),
    ) !==
    JSON.stringify(
      [...seen, 'manifest.json'].sort((a, b) => a.localeCompare(b)),
    )
  )
    throw Error('提交副本原件归档目录含缺失或额外文件');
  // Bind the staging bytes to the recorded tar, not just to a nearby manifest.
  const tarNames = execFileSync('tar', ['-tzf', sourceArchivePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  })
    .trimEnd()
    .split('\n');
  const tarTypes = execFileSync('tar', ['-tvzf', sourceArchivePath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  })
    .trimEnd()
    .split('\n');
  const tarSeen = new Set(),
    tarFiles = new Set();
  if (tarNames.length !== tarTypes.length)
    throw Error('原件归档成员类型不完整');
  for (const [index, name] of tarNames.entries()) {
    const directory = name.endsWith('/');
    const relative = evidenceRelativeName(directory ? name.slice(0, -1) : name);
    if (
      tarSeen.has(name) ||
      tarTypes[index][0] !== (directory ? 'd' : '-') ||
      (directory
        ? !observed.directories.includes(relative)
        : !seen.has(name) && name !== 'manifest.json')
    )
      throw Error('原件归档含重复、额外或特殊成员');
    tarSeen.add(name);
    if (!directory) tarFiles.add(name);
  }
  if (tarFiles.size !== seen.size + 1) throw Error('原件归档成员缺失');
  const tarManifest = execFileSync(
    'tar',
    ['-xOzf', sourceArchivePath, '--', 'manifest.json'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (!tarManifest.equals(manifestBytes))
    throw Error('原件归档中的清单与保全目录不符');
  for (const [name, input] of inputs) {
    const bytes = execFileSync(
      'tar',
      ['-xOzf', sourceArchivePath, '--', name],
      {
        maxBuffer: Math.max(1024 * 1024, input.bytes.length + 1024),
        timeout: 60000,
      },
    );
    if (!bytes.equals(input.bytes)) throw Error('原件归档内容与保全目录不符');
  }
  const evaluation = JSON.parse(
    inputs.get('evaluation.json')?.bytes.toString('utf8') || '{}',
  );
  if (
    evaluation.taskId !== path.basename(path.resolve(dir)) ||
    evaluation.turnId !== turnId ||
    !evaluation.container?.containerId ||
    !evaluation.traceExport?.verified
  )
    throw Error('原件评测缺少本轮完整原生轨迹身份回执');
  const sourceNativeManifest = inputs.get('native/manifest.json');
  let sourceNativeDirectories = observed.directories.filter(
    (name) => name === 'native' || name.startsWith('native/'),
  );
  if (sourceNativeManifest) {
    const recorded = JSON.parse(sourceNativeManifest.bytes.toString('utf8'));
    if (
      recorded.containerId !== evaluation.container.containerId ||
      !Array.isArray(recorded.files) ||
      !recorded.files.length ||
      recorded.files.length !== evaluation.traceExport.files ||
      hash(JSON.stringify(recorded.files)) !== evaluation.traceExport.sha256
    )
      throw Error('原件归档原生目录与原轮评测回执不符');
    const expected = new Set(['native/manifest.json']);
    for (const file of recorded.files) {
      evidenceRelativeName(file.name);
      const name = 'native/projects/' + file.name;
      const input = inputs.get(name);
      if (
        expected.has(name) ||
        !input ||
        input.bytes.length !== file.bytes ||
        input.originalSha256 !== file.sha256
      )
        throw Error('原件归档原生文件大小或摘要不符');
      expected.add(name);
    }
    if (
      [...inputs.keys()].some(
        (name) => name.startsWith('native/') && !expected.has(name),
      ) ||
      (sourceManifest.nativeTrace &&
        (sourceManifest.nativeTrace.sha256 !== evaluation.traceExport.sha256 ||
          sourceManifest.nativeTrace.manifestSha256 !==
            sourceNativeManifest.originalSha256))
    )
      throw Error('原件归档原生目录与清单不符');
  } else {
    if ([...inputs.keys()].some((name) => name.startsWith('native/')))
      throw Error('原件归档原生目录缺少清单');
    // Older archives omitted the native tree. Preserve the retained original
    // export in this derivative without changing the old archive.
    const original = verifyNativeExport(evaluation.traceExport, {
      dir,
      containerId: evaluation.container.containerId,
    });
    sourceNativeDirectories = [
      'native',
      'native/projects',
      ...original.directories.map((name) => 'native/projects/' + name),
    ];
    for (const file of original.files)
      inputs.set('native/projects/' + file.name, {
        bytes: readFileSync(path.join(original.root, file.name)),
        originalSha256: file.sha256,
        source: 'source-turn-native-export',
      });
    inputs.set('native/manifest.json', {
      bytes: readFileSync(original.manifestPath),
      originalSha256: original.manifestSha256,
      source: 'source-turn-native-export',
    });
  }
  const sourceIdentity = {
    taskId: evaluation.taskId,
    questionId: evaluation.questionRootId || evaluation.container.questionId,
    containerId: evaluation.container.containerId,
    runId: evaluation.container.terminal?.runId || finalization?.runId,
    sessionId: evaluation.sessionId || null,
  };
  if (
    evaluation.questionRootId &&
    evaluation.container.questionId &&
    evaluation.questionRootId !== evaluation.container.questionId
  )
    throw Error('原件评测题目身份不一致');
  const final = finalization
    ? verifiedFinalization(finalization, {
        dir,
        identity: sourceIdentity,
        terminal: evaluation.container.terminal,
      })
    : null;
  if (
    final
      ? !isDeepStrictEqual(final.traceExport, traceExport)
      : evaluation.traceExport.sha256 !== traceExport?.sha256
  )
    throw Error('完整原生轨迹与原件评测回执或最终终端回执不符');
  const native = verifyNativeExport(traceExport, {
    dir,
    containerId: evaluation.container?.containerId,
  });
  if (final) {
    if (
      [...inputs.keys(), ...observed.directories].some(
        (name) =>
          name === 'source-turn' ||
          name.startsWith('source-turn/') ||
          name === 'finalization' ||
          name.startsWith('finalization/'),
      )
    )
      throw Error('原件归档占用最终提交保留路径');
    for (const [name, input] of inputs) {
      if (!name.startsWith('native/')) continue;
      inputs.delete(name);
      inputs.set('source-turn/' + name, { ...input, sourceName: name });
    }
    const bytes = readFileSync(final.receiptPath);
    inputs.set('finalization/receipt.json', {
      bytes,
      originalSha256: final.receiptSha256,
      source: 'terminal-finalization',
    });
  }
  const nativeNames = new Set(
    native.files.map((file) => 'native/projects/' + file.name),
  );
  if (
    [...inputs.keys()].some(
      (name) => name.startsWith('native/projects/') && !nativeNames.has(name),
    )
  )
    throw Error('原件归档包含完整原生清单之外的文件');
  for (const file of native.files) {
    const name = 'native/projects/' + file.name;
    const bytes = readFileSync(path.join(native.root, file.name));
    if (inputs.has(name) && inputs.get(name).originalSha256 !== file.sha256)
      throw Error('原件归档与完整原生轨迹冲突');
    inputs.set(name, {
      bytes,
      originalSha256: file.sha256,
      source: 'native-export',
    });
  }
  const exportManifest = readFileSync(native.manifestPath);
  if (
    inputs.has('native/manifest.json') &&
    inputs.get('native/manifest.json').originalSha256 !== hash(exportManifest)
  )
    throw Error('原件归档与完整原生清单冲突');
  inputs.set('native/manifest.json', {
    bytes: exportManifest,
    originalSha256: hash(exportManifest),
    source: 'native-export',
  });
  if (inputs.has('source-evidence-manifest.json'))
    throw Error('原件归档占用提交清单保留路径');
  inputs.set('source-evidence-manifest.json', {
    bytes: manifestBytes,
    originalSha256: hash(manifestBytes),
    source: 'evidence-archive',
  });
  const destination = path.join(dir, turnId + '.submission-' + randomUUID());
  mkdirSync(destination, { mode: 0o700 });
  const nameMap = new Map();
  function mappedName(name) {
    if (nameMap.has(name)) return nameMap.get(name);
    evidenceRelativeName(name);
    const mapped = name
      .split('/')
      .map((part) => {
        const sanitized = sanitizeSensitiveText(part, { knownSecrets });
        return sanitized.changed
          ? sanitized.text + '.' + hash(part).slice(0, 12)
          : part;
      })
      .join('/');
    evidenceRelativeName(mapped);
    nameMap.set(name, mapped);
    return mapped;
  }
  const originalDirectories = [
    ...new Set([
      ...observed.directories.map((name) =>
        final && (name === 'native' || name.startsWith('native/'))
          ? 'source-turn/' + name
          : name,
      ),
      ...sourceNativeDirectories.map((name) =>
        final ? 'source-turn/' + name : name,
      ),
      ...(final ? ['source-turn', 'finalization'] : []),
      'native',
      'native/projects',
      ...native.directories.map((name) => 'native/projects/' + name),
    ]),
  ];
  const directories = originalDirectories
    .map(mappedName)
    .sort((a, b) => a.localeCompare(b));
  const directoryMappings = originalDirectories.map((name) => ({
    name: mappedName(name),
    sourceNameSha256: hash(name),
  }));
  for (const name of directories)
    mkdirSync(path.join(destination, name), { recursive: true, mode: 0o700 });
  const files = [],
    allFindings = [],
    reviewRequiredFiles = [],
    targetNames = new Set();
  if (final && !evaluation.container.terminal)
    reviewRequiredFiles.push({
      name: 'finalization/receipt.json',
      reason: 'missing-original-terminal-binding',
    });
  if (final && (!final.sessionId || !sourceIdentity.sessionId))
    reviewRequiredFiles.push({
      name: 'finalization/receipt.json',
      reason: 'missing-original-session-binding',
    });
  if (
    final &&
    (final.commandTransport !== 'original-mac-terminal' ||
      final.traceExport.exportKind !== 'final')
  )
    reviewRequiredFiles.push({
      name: 'finalization/receipt.json',
      reason: 'legacy-command-transport',
    });
  for (const [originalName, input] of inputs) {
    const name = mappedName(originalName);
    if (name === 'manifest.json' || targetNames.has(name))
      throw Error('脱敏后的提交文件名冲突');
    targetNames.add(name);
    let bytes = input.bytes,
      findings = [],
      scanStatus = 'passed',
      sqliteScan,
      reason;
    try {
      if (isSqlite(input.bytes)) {
        sqliteScan = scanSqliteContent(input.bytes, { knownSecrets });
        scanStatus = sqliteScan.status;
        reason = sqliteScan.reason;
      } else {
        if (binaryExtension.test(originalName)) throw Error('unsupported');
        const text = decode.decode(input.bytes);
        if (text.includes('\u0000')) throw Error('unsupported');
        validStructuredText(originalName, text);
        const sanitized = sanitizePackageText(originalName, text, knownSecrets);
        validStructuredText(originalName, sanitized.text);
        findings = sanitized.findings;
        bytes = Buffer.from(sanitized.text, 'utf8');
        if (
          sanitizePackageText(originalName, sanitized.text, knownSecrets)
            .findings.length
        ) {
          scanStatus = 'needs_review';
          reason = 'residual-sensitive-content';
        }
      }
    } catch {
      scanStatus = 'needs_review';
      reason = 'unsupported-binary-encoding-or-structure';
    }
    const nameFindings = sanitizeSensitiveText(originalName, {
      knownSecrets,
    }).findings;
    if (sanitizeSensitiveText(name, { knownSecrets }).findings.length) {
      scanStatus = 'needs_review';
      reason = 'residual-sensitive-filename';
    }
    const target = path.join(destination, name);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    const file = {
      name,
      source: input.source,
      sourceName: sanitizeSensitiveText(input.sourceName || originalName, {
        knownSecrets,
      }).text,
      sourceNameSha256: hash(input.sourceName || originalName),
      originalSha256: input.originalSha256,
      originalBytes: input.bytes.length,
      submissionSha256: hash(bytes),
      submissionBytes: bytes.length,
      ...(sqliteScan ? { sqliteScan } : {}),
      textFormat: sqliteScan
        ? 'sqlite'
        : /\.jsonl$/i.test(originalName)
          ? 'jsonl'
          : /\.json$/i.test(originalName)
            ? 'json'
            : 'text',
      changed: !bytes.equals(input.bytes) || name !== originalName,
      redactions: redactionCounts([...findings, ...nameFindings]),
      scanStatus,
    };
    files.push(file);
    allFindings.push(...findings, ...nameFindings);
    if (reason) reviewRequiredFiles.push({ name, reason });
  }
  const manifest = {
    version: submissionPackageVersion,
    scannerVersion: sensitiveContentVersion,
    purpose: '脱敏提交副本；内部原件与业务结论保持不变',
    status: reviewRequiredFiles.length
      ? 'needs_review'
      : final
        ? 'passed'
        : 'awaiting_finalization',
    contentScanStatus: files.every((file) => file.scanStatus === 'passed')
      ? 'passed'
      : 'needs_review',
    sourceIdentity,
    sourceTurnTraceExportSha256: evaluation.traceExport.sha256,
    finalizationReceiptSha256: final?.receiptSha256 || null,
    finalizationCommandTransport: final?.commandTransport || null,
    originalTerminalBound: Boolean(final && evaluation.container.terminal),
    sourceArchiveSha256: archive.sha256,
    sourceManifestSha256: hash(manifestBytes),
    traceExportSha256: native.sha256,
    traceExportManifestSha256: native.manifestSha256,
    nativeContainerId: native.containerId,
    nativeFiles: native.files.length,
    files,
    directories,
    directoryMappings,
    redactions: redactionCounts(allFindings),
    reviewRequiredFiles,
    checkedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(destination, 'manifest.json');
  const manifestText = JSON.stringify(manifest, null, 2);
  if (sanitizeSensitiveText(manifestText, { knownSecrets }).findings.length)
    throw Error('提交清单仍含敏感信息，未发布提交包');
  writeFileSync(manifestPath, manifestText, { mode: 0o600, flag: 'wx' });
  for (const file of files)
    if (
      hash(readFileSync(path.join(destination, file.name))) !==
      file.submissionSha256
    )
      throw Error('提交副本在封装前发生变化');
  if (
    JSON.stringify(verifyNativeExport(traceExport, { dir })) !==
      JSON.stringify(native) ||
    hash(readFileSync(sourceArchivePath)) !== archive.sha256 ||
    hash(readFileSync(sourceManifestPath)) !== hash(manifestBytes)
  )
    throw Error('提交副本生成期间原件发生变化');
  if (final)
    verifiedFinalization(final, {
      dir,
      identity: sourceIdentity,
      terminal: evaluation.container.terminal,
    });
  const archivePath = destination + '.tar.gz';
  execFileSync(
    'tar',
    [
      '-czf',
      archivePath,
      '-C',
      destination,
      '--',
      ...files.map((f) => f.name),
      'manifest.json',
      ...directories.filter(
        (name) => !files.some((file) => file.name.startsWith(name + '/')),
      ),
    ],
    { timeout: 60000 },
  );
  const zipArchivePath = destination + '.zip';
  const zipped = Object.create(null);
  for (const name of directories) zipped[name + '/'] = new Uint8Array();
  for (const file of files)
    zipped[file.name] = readFileSync(path.join(destination, file.name));
  zipped['manifest.json'] = readFileSync(manifestPath);
  writeFileSync(zipArchivePath, zipSync(zipped, { level: 6 }), {
    mode: 0o600,
    flag: 'wx',
  });
  const result = {
    version: submissionPackageVersion,
    scannerVersion: sensitiveContentVersion,
    status: manifest.status,
    contentScanStatus: manifest.contentScanStatus,
    finalization: final,
    archivePath,
    sha256: hash(readFileSync(archivePath)),
    zipArchivePath,
    zipSha256: hash(readFileSync(zipArchivePath)),
    zipBytes: readFileSync(zipArchivePath).length,
    manifestPath,
    manifestSha256: hash(readFileSync(manifestPath)),
    files: files.length,
    redactions: manifest.redactions,
    reviewRequiredFiles,
    sourceArchiveSha256: archive.sha256,
    traceExportSha256: native.sha256,
    verifiedAt: manifest.checkedAt,
  };
  const verificationPath = destination + '.verification.json';
  writeFileSync(verificationPath, JSON.stringify(result, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  const receipt = {
    ...result,
    verificationPath,
    verificationSha256: hash(readFileSync(verificationPath)),
  };
  if (receipt.status === 'passed')
    verifySubmissionPackage(receipt, {
      dir,
      sourceArchive: archive,
      traceExport,
      knownSecrets,
    });
  return receipt;
}

function unzipSubmission(bytes) {
  // Check the central directory before inflation so duplicate paths, symlinks,
  // encryption and oversized expansion cannot hide behind an object key.
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--)
    if (bytes.readUInt32LE(end) === 0x06054b50) break;
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
  )
    throw Error('提交 ZIP 目录无效');
  const entries = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16),
    expanded = 0;
  if (entries > 20000 || cursor + size !== end)
    throw Error('提交 ZIP 目录范围无效');
  const names = new Set();
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw Error('提交 ZIP 成员无效');
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10);
    const length = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const name = decode.decode(
      bytes.subarray(cursor + 46, cursor + 46 + length),
    );
    const fileType = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0o170000;
    const isDir = name.endsWith('/');
    evidenceRelativeName(isDir ? name.slice(0, -1) : name);
    expanded += bytes.readUInt32LE(cursor + 24);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      names.has(name) ||
      expanded > 512 * 1024 * 1024 ||
      ![0, isDir ? 0o040000 : 0o100000].includes(fileType)
    )
      throw Error('提交 ZIP 含重复、加密、特殊文件或超限内容');
    names.add(name);
    const local = bytes.readUInt32LE(cursor + 42);
    if (
      local + 30 > bytes.length ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      decode.decode(
        bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)),
      ) !== name
    )
      throw Error('提交 ZIP 本地成员路径不符');
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw Error('提交 ZIP 成员数量不符');
  const files = unzipSync(bytes);
  if (Object.keys(files).length !== names.size)
    throw Error('提交 ZIP 成员丢失');
  return files;
}

export function verifySubmissionPackage(
  submission,
  {
    dir,
    sourceArchive,
    traceExport,
    maxBytes,
    knownSecrets = [],
    purpose = 'internal-copy',
  } = {},
) {
  if (!['internal-copy', 'native-only'].includes(purpose))
    throw Error('提交核验用途无效');
  const nativeOnly = purpose === 'native-only';
  const warnings = nativeOnly ? internalContentWarnings(submission) : [];
  if (nativeOnly && !sourceArchive) throw Error('原生上传核验缺少源归档');
  if (submission?.status === 'awaiting_finalization')
    throw Error('提交包仍等待原终端最终导出和清理回执');
  if (
    submission?.version !== submissionPackageVersion ||
    (!nativeOnly && submission.scannerVersion !== sensitiveContentVersion) ||
    (!warnings.length &&
      (submission.status !== 'passed' ||
        submission.reviewRequiredFiles?.length))
  )
    throw Error('提交包尚未通过完整脱敏检查，需人工复核');
  if (
    maxBytes !== undefined &&
    (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
  )
    throw Error('提交包大小上限无效');
  const verificationPath = evidencePath(submission.verificationPath, dir);
  if (hash(readFileSync(verificationPath)) !== submission.verificationSha256)
    throw Error('提交包检查回执摘要不符');
  const {
    verificationPath: _path,
    verificationSha256: _sha,
    ...record
  } = submission;
  if (
    JSON.stringify(JSON.parse(readFileSync(verificationPath, 'utf8'))) !==
    JSON.stringify(record)
  )
    throw Error('提交包检查回执与当前记录不符');
  const manifestPath = evidencePath(submission.manifestPath, dir);
  const manifestBytes = readFileSync(manifestPath),
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    hash(manifestBytes) !== submission.manifestSha256 ||
    manifest.status !== submission.status ||
    manifest.version !== submissionPackageVersion ||
    manifest.scannerVersion !== submission.scannerVersion ||
    !isDeepStrictEqual(
      manifest.reviewRequiredFiles,
      submission.reviewRequiredFiles,
    ) ||
    manifest.sourceArchiveSha256 !== submission.sourceArchiveSha256 ||
    manifest.traceExportSha256 !== submission.traceExportSha256 ||
    manifest.files.length !== submission.files ||
    manifest.contentScanStatus !== submission.contentScanStatus ||
    (!warnings.length && submission.contentScanStatus !== 'passed') ||
    manifest.originalTerminalBound !== true
  )
    throw Error('提交包检查清单不符');
  const final = verifiedFinalization(submission.finalization, {
    dir,
    identity: manifest.sourceIdentity,
  });
  if (
    final.commandTransport !== 'original-mac-terminal' ||
    final.traceExport.exportKind !== 'final' ||
    manifest.finalizationCommandTransport !== final.commandTransport ||
    manifest.finalizationReceiptSha256 !== final.receiptSha256 ||
    manifest.nativeContainerId !== final.containerId ||
    !manifest.sourceIdentity.sessionId ||
    final.sessionId !== manifest.sourceIdentity.sessionId ||
    (traceExport && !isDeepStrictEqual(traceExport, final.traceExport))
  )
    throw Error('提交 ZIP 未绑定原终端最终完成回执');
  const zipBytes = readFileSync(evidencePath(submission.zipArchivePath, dir));
  if (
    hash(zipBytes) !== submission.zipSha256 ||
    zipBytes.length !== submission.zipBytes
  )
    throw Error('提交 ZIP 摘要或大小不符');
  if (maxBytes !== undefined && zipBytes.length > maxBytes)
    throw Error('提交 ZIP 超过平台当前大小上限');
  if (
    hash(readFileSync(evidencePath(submission.archivePath, dir))) !==
    submission.sha256
  )
    throw Error('提交副本归档摘要不符');
  const entries = unzipSubmission(zipBytes),
    expected = new Set(['manifest.json']);
  if (!Buffer.from(entries['manifest.json'] || []).equals(manifestBytes))
    throw Error('提交 ZIP 清单不符');
  for (const name of manifest.directories) {
    evidenceRelativeName(name);
    if (
      expected.has(name + '/') ||
      !entries[name + '/'] ||
      entries[name + '/'].length
    )
      throw Error('提交 ZIP 目录不完整');
    expected.add(name + '/');
  }
  for (const file of manifest.files) {
    evidenceRelativeName(file.name);
    if (
      expected.has(file.name) ||
      (!nativeOnly && file.scanStatus !== 'passed') ||
      !/^[a-f0-9]{64}$/.test(file.originalSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(file.sourceNameSha256 || '')
    )
      throw Error('提交 ZIP 文件映射无效');
    expected.add(file.name);
    const bytes = entries[file.name];
    if (
      !bytes ||
      hash(bytes) !== file.submissionSha256 ||
      bytes.length !== file.submissionBytes
    )
      throw Error('提交 ZIP 文件摘要或大小不符');
    const staged = evidencePath(
      path.join(path.dirname(manifestPath), file.name),
      dir,
    );
    if (hash(readFileSync(staged)) !== file.submissionSha256)
      throw Error('提交副本文件已变化');
    // These bytes are local evidence, not the outgoing native attachment.
    // Keep verifying inventory and hashes without repeating its content scan.
    if (nativeOnly) continue;
    if (file.textFormat === 'sqlite') {
      const scan = scanSqliteContent(bytes, { knownSecrets });
      if (
        scan.status !== 'passed' ||
        !isDeepStrictEqual(scan, file.sqliteScan) ||
        file.originalSha256 !== file.submissionSha256 ||
        file.originalBytes !== file.submissionBytes ||
        sanitizeSensitiveText(file.name, { knownSecrets }).findings.length
      )
        throw Error('提交 ZIP 数据库内容尚未验清');
      continue;
    }
    const text = decode.decode(bytes),
      formatName = 'content.' + file.textFormat;
    if (!['json', 'jsonl', 'text'].includes(file.textFormat))
      throw Error('提交 ZIP 文本格式未知');
    validStructuredText(formatName, text);
    if (
      binaryExtension.test(file.name) ||
      text.includes('\u0000') ||
      sanitizePackageText(formatName, text, knownSecrets).findings.length ||
      sanitizeSensitiveText(file.name, { knownSecrets }).findings.length
    )
      throw Error('提交 ZIP 含未验清的内容');
  }
  if (
    Object.keys(entries).length !== expected.size ||
    Object.keys(entries).some((name) => !expected.has(name))
  )
    throw Error('提交 ZIP 含缺失或额外成员');
  if (
    !nativeOnly &&
    sanitizeSensitiveText(manifestBytes.toString('utf8'), { knownSecrets })
      .findings.length
  )
    throw Error('提交 ZIP 清单含未处理敏感信息');
  if (
    sourceArchive &&
    (sourceArchive.sha256 !== submission.sourceArchiveSha256 ||
      hash(readFileSync(evidencePath(sourceArchive.archivePath, dir))) !==
        sourceArchive.sha256)
  )
    throw Error('提交 ZIP 与内部原件归档不符');
  {
    const native = verifyNativeExport(final.traceExport, {
      dir,
      containerId: manifest.nativeContainerId,
    });
    if (
      native.sha256 !== submission.traceExportSha256 ||
      native.manifestSha256 !== manifest.traceExportManifestSha256
    )
      throw Error('提交 ZIP 与完整原生轨迹不符');
    const included = manifest.files.filter(
      (file) =>
        file.source === 'native-export' &&
        file.sourceName !== 'native/manifest.json',
    );
    if (
      included.length !== native.files.length ||
      native.files.some(
        (file) =>
          !included.some(
            (item) =>
              item.sourceNameSha256 === hash('native/projects/' + file.name) &&
              item.originalSha256 === file.sha256,
          ),
      )
    )
      throw Error('提交 ZIP 未完整保留原生目录文件');
    if (
      !manifest.files.some(
        (file) =>
          file.source === 'terminal-finalization' &&
          file.sourceNameSha256 === hash('finalization/receipt.json') &&
          file.originalSha256 === final.receiptSha256,
      )
    )
      throw Error('提交 ZIP 缺少原终端最终回执副本');
    for (const name of [
      'native',
      'native/projects',
      ...native.directories.map((name) => 'native/projects/' + name),
    ])
      if (
        !manifest.directoryMappings.some(
          (item) =>
            item.sourceNameSha256 === hash(name) &&
            manifest.directories.includes(item.name),
        )
      )
        throw Error('提交 ZIP 未完整保留原生目录结构');
  }
  return {
    passed: true,
    status: 'passed',
    zipArchivePath: submission.zipArchivePath,
    zipSha256: submission.zipSha256,
    files: manifest.files.length,
    purpose,
    contentScanStatus: submission.contentScanStatus,
    internalWarnings: warnings,
  };
}
