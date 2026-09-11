import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { verifyNativeExport, evidenceRelativeName } from './evidence.mjs';
import { digest } from './solo-records.mjs';
import { savePrivateJSON } from './solo-client.mjs';
import { auditPermissionTraces } from '../lib/permission-audit.mjs';
import { permissionAdmission } from './solo-permission-admission.mjs';

export const soloNativeAttachmentVersion = '2026-09-11.native-verbatim-jsonl2';

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
  admissionRoot = path.join(path.dirname(dir), 'solo-upload'),
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
    // Decode only for read-only identity/permission checks. The attachment keeps
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
  // The current SOLO form accepts one .jsonl only. A single file is complete
  // only when the verified export contains no other files. Never discard
  // subagents/metadata, merge JSONL files, or rename ZIP bytes to bypass it.
  if (native.files.length !== 1 || !/\.jsonl$/i.test(native.files[0].name))
    throw Error(
      '平台仅接收单个 JSONL，完整原生导出包含其他文件，暂缓上传；不能省略子会话或合并轨迹',
    );
  const source = native.files[0];
  const bytes = entries[nameFor(source.name)];
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || bytes.length > maxBytes)
    throw Error('原生轨迹 JSONL 超过平台附件大小上限');
  const sha256 = digest(bytes);
  const admission = !permission.passed
    ? permissionAdmission(
        {
          taskId: path.basename(dir),
          turnId,
          sessionId,
          promptId,
          permission,
          traceExportSha256: native.sha256,
          nativeManifestSha256: native.manifestSha256,
          attachmentSha256: sha256,
        },
        admissionRoot,
      )
    : null;
  if (!permission.passed && !admission)
    throw Error('最终完整原生轨迹权限核验未通过');
  const attachmentDir = path.join(
    dir,
    `${turnId}.solo-native-${sha256.slice(0, 20)}`,
  );
  fs.mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
  const file = path.join(attachmentDir, path.basename(source.name));
  if (fs.existsSync(file)) {
    if (digest(fs.readFileSync(file)) !== sha256)
      throw Error('已有原生轨迹 JSONL 摘要不符');
  } else fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  if (!fs.readFileSync(file).equals(bytes))
    throw Error('原生轨迹 JSONL 写入后与原件不一致');
  // The audit stays outside the attachment and never changes the native file.
  savePrivateJSON(file + '.audit.json', {
    version: 2,
    policyVersion: soloNativeAttachmentVersion,
    kind: 'solo-native-only',
    format: 'jsonl',
    completeNativeFileSet: true,
    sourceName: source.name,
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
    permissionPassed: permission.passed,
    denialCount: permission.denialCount,
    permission,
    userAuthorizedPermissionException: admission,
  });
  return {
    name: path.basename(file),
    path: file,
    bytes,
    sha256,
    status: 'passed',
    format: 'jsonl',
    policyVersion: soloNativeAttachmentVersion,
    byteIdentical: true,
    permissionPassed: permission.passed,
    userAuthorizedPermissionException: admission,
  };
}

// Rebuilding above rechecks the final source manifest. At send time also check
// the exact file selected by the browser, not just the cached packet's digest.
export function assertPreparedNativeAttachment(archive, prepared) {
  if (
    archive.policyVersion !== soloNativeAttachmentVersion ||
    archive.format !== 'jsonl' ||
    !/\.jsonl$/i.test(archive.name) ||
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
