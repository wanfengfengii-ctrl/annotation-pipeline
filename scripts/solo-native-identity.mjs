import fs from 'node:fs';
import path from 'node:path';
import { verifyNativeExport } from './evidence.mjs';

// Legacy pipeline promptId stores the user-message UUID used by its observer.
// SOLO expects the separate promptId written by Claude on that same event.
// Resolve from immutable evidence; never substitute a different user turn.
export function resolveSoloNativeIdentity({
  dir,
  traceExport,
  containerId,
  sessionId,
  messageUuid,
}) {
  const native = verifyNativeExport(traceExport, { dir, containerId });
  const found = [];
  for (const file of native.files.filter((f) => f.name.endsWith('.jsonl'))) {
    const lines = fs
      .readFileSync(path.join(native.root, file.name), 'utf8')
      .split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (
        e.type !== 'user' ||
        e.isSidechain ||
        typeof e.message?.content !== 'string' ||
        e.sessionId !== sessionId ||
        e.uuid !== messageUuid
      )
        continue;
      if (typeof e.promptId !== 'string' || !e.promptId.trim())
        throw Error(
          '原始用户消息缺少 Claude 原生 promptId，不能用消息 UUID 代替',
        );
      found.push({
        sessionId,
        messageUuid: e.uuid,
        promptId: e.promptId,
        file: file.name,
        line: index + 1,
        traceExportSha256: native.sha256,
        manifestSha256: native.manifestSha256,
      });
    }
  }
  if (found.length !== 1)
    throw Error('无法唯一定位本轮原始用户消息的原生 PromptID');
  return found[0];
}
