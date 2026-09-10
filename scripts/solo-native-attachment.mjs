import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { zipSync, unzipSync } from 'fflate';
import { verifyNativeExport, evidenceRelativeName } from './evidence.mjs';
import { digest } from './solo-records.mjs';
import { savePrivateJSON } from './solo-client.mjs';
import { auditPermissionTraces } from '../lib/permission-audit.mjs';

export const soloNativeAttachmentVersion = '2026-09-10.native-verbatim1';

// SOLO's attachment classifier expects native CLI traces. Internal evaluation,
// runtime, workspace and manifest files stay in the separately verified archive.
// This function checks native evidence; it does not grant upload eligibility or
// waive the caller's original-terminal finalization policy.
export function createSoloNativeAttachment({
  dir,
  turnId,
  traceExport,
  containerId,
  sessionId,
  promptId,
  maxBytes = 20 * 1024 * 1024,
}) {
  if (!/^[\w-]+$/.test(turnId || '') || !sessionId || !promptId)
    throw Error('原生轨迹附件缺少记录标识');
  const native = verifyNativeExport(traceExport, { dir, containerId });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries = Object.create(null),
    mapping = [],
    rawTraces = [];
  let foundPrompt = false;
  const nameFor = (name) => evidenceRelativeName('projects/' + name);
  for (const directory of native.directories) {
    const name = nameFor(directory) + '/';
    if (entries[name]) throw Error('原生轨迹目录映射冲突');
    entries[name] = new Uint8Array();
  }
  for (const file of native.files) {
    const name = nameFor(file.name);
    if (entries[name] || entries[name + '/'])
      throw Error('原生轨迹文件映射冲突');
    const original = fs.readFileSync(path.join(native.root, file.name));
    if (original.length !== file.bytes || digest(original) !== file.sha256)
      throw Error('原生轨迹在打包时发生变化');
    // Decode only for read-only identity/permission checks. The ZIP receives
    // the original buffer: no redaction, reserialization or newline conversion.
    const text = decoder.decode(original);
    if (text.includes('\0') || !/\.(jsonl|json)$/i.test(file.name))
      throw Error('原生目录含需单独复核的非 JSON/JSONL 文件');
    if (/\.jsonl$/i.test(file.name)) {
      rawTraces.push({ name: file.name, content: text });
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (
          event.type === 'user' &&
          !event.isSidechain &&
          typeof event.message?.content === 'string' &&
          event.sessionId === sessionId &&
          event.promptId === promptId
        )
          foundPrompt = true;
      }
    } else {
      JSON.parse(text);
    }
    entries[name] = original;
    mapping.push({
      name,
      sourceNameSha256: digest(file.name),
      originalSha256: file.sha256,
      sha256: digest(original),
      bytes: original.length,
      redactions: 0,
      byteIdentical: true,
    });
  }
  if (!foundPrompt)
    throw Error('完整原生轨迹中找不到本轮 SessionID 和 PromptID');
  const permission = auditPermissionTraces(rawTraces);
  if (!permission.passed) throw Error('最终完整原生轨迹权限核验未通过');
  // Fixed metadata makes repeated preparation byte-identical for send-time checks.
  const bytes = Buffer.from(
    zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }),
  );
  if (bytes.length > maxBytes) throw Error('原生轨迹 ZIP 超过平台附件大小上限');
  const unzipped = unzipSync(bytes);
  if (
    Object.keys(unzipped).length !== Object.keys(entries).length ||
    Object.entries(entries).some(
      ([name, value]) =>
        !unzipped[name] || !Buffer.from(unzipped[name]).equals(value),
    )
  )
    throw Error('原生轨迹 ZIP 内容校验失败');
  const sha256 = digest(bytes);
  const file = path.join(
    dir,
    `${turnId}.solo-native-${sha256.slice(0, 20)}.zip`,
  );
  if (fs.existsSync(file)) {
    if (digest(fs.readFileSync(file)) !== sha256)
      throw Error('已有原生轨迹 ZIP 摘要不符');
  } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  // The audit stays local: inserting this JSON in the ZIP would confuse SOLO's
  // native-trace classifier in the same way as the old internal evidence bundle.
  savePrivateJSON(file + '.audit.json', {
    version: 2,
    policyVersion: soloNativeAttachmentVersion,
    kind: 'solo-native-only',
    sessionId,
    promptId,
    originalsPreserved: true,
    byteIdentical: true,
    redactions: 0,
    traceExportSha256: native.sha256,
    nativeManifestSha256: native.manifestSha256,
    sha256,
    files: mapping,
    directories: Object.keys(entries).filter((n) => n.endsWith('/')),
    permissionPassed: true,
    denialCount: 0,
  });
  return {
    name: path.basename(file),
    path: file,
    bytes,
    sha256,
    status: 'passed',
    policyVersion: soloNativeAttachmentVersion,
    byteIdentical: true,
  };
}

// Rebuilding above rechecks the final source manifest. At send time also check
// the exact file selected by the browser, not just the cached packet's digest.
export function assertPreparedNativeAttachment(archive, prepared) {
  if (
    archive.policyVersion !== soloNativeAttachmentVersion ||
    archive.byteIdentical !== true ||
    digest(archive.bytes) !== archive.sha256 ||
    prepared?.sha256 !== archive.sha256 ||
    prepared?.path !== archive.path ||
    prepared?.name !== archive.name ||
    prepared?.bytes !== archive.bytes.length ||
    !fs.readFileSync(prepared.path).equals(archive.bytes)
  )
    throw Error('待上传附件与原生文件不一致，请重新准备；禁止上传替换版轨迹');
}
