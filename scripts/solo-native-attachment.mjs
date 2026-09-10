import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { zipSync, unzipSync } from 'fflate';
import { verifyNativeExport, evidenceRelativeName } from './evidence.mjs';
import { digest } from './solo-records.mjs';
import { savePrivateJSON } from './solo-client.mjs';
import { auditPermissionTraces } from '../lib/permission-audit.mjs';
import { sanitizeSensitiveText } from '../lib/sensitive-content.mjs';

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
  knownSecrets = [],
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
  const nameFor = (name) => {
    const result = sanitizeSensitiveText('projects/' + name, { knownSecrets });
    evidenceRelativeName(result.text);
    if (sanitizeSensitiveText(result.text, { knownSecrets }).findings.length)
      throw Error('原生轨迹路径敏感检查未通过');
    return result.text;
  };
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
    const text = decoder.decode(original);
    if (text.includes('\0') || !/\.(jsonl|json)$/i.test(file.name))
      throw Error('原生目录含需单独复核的非 JSON/JSONL 文件');
    let redactions = 0;
    const sanitize = (value) => {
      const cleaned = sanitizeSensitiveText(value, { knownSecrets });
      if (sanitizeSensitiveText(cleaned.text, { knownSecrets }).findings.length)
        throw Error('原生轨迹脱敏复查未通过');
      redactions += cleaned.findings.length;
      return cleaned.text;
    };
    let copy;
    if (/\.jsonl$/i.test(file.name)) {
      rawTraces.push({ name: file.name, content: text });
      copy = text
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          const event = JSON.parse(line);
          if (
            event.type === 'user' &&
            !event.isSidechain &&
            typeof event.message?.content === 'string' &&
            event.sessionId === sessionId &&
            event.promptId === promptId
          )
            foundPrompt = true;
          const cleaned = sanitize(line);
          const result = JSON.parse(cleaned);
          if (
            result.uuid !== event.uuid ||
            result.promptId !== event.promptId ||
            result.sessionId !== event.sessionId ||
            result.type !== event.type
          )
            throw Error('脱敏不能改变原生事件标识');
          return cleaned;
        })
        .join('\n');
    } else {
      JSON.parse(text);
      copy = sanitize(text);
      JSON.parse(copy);
    }
    const bytes = Buffer.from(copy);
    entries[name] = bytes;
    mapping.push({
      name,
      sourceNameSha256: digest(file.name),
      originalSha256: file.sha256,
      sha256: digest(bytes),
      bytes: bytes.length,
      redactions,
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
    version: 1,
    kind: 'solo-native-only',
    sessionId,
    promptId,
    originalsPreserved: true,
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
  };
}
