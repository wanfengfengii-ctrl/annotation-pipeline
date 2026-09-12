import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DockerRuntime } from './docker-runtime.mjs';
import { isNativeUserMessage } from '../lib/native-user-message.mjs';
import { readJSON } from './self-heal-io.mjs';

// Read-only diagnosis. A similarity observation is never a completion receipt
// and does not authorize replay, terminal input or mutation of original JSONL.
export function summarizeNativeEvidence(files, prompt, previousIds = []) {
  return files.map((file) => {
    const events = file.content.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const users = events.flatMap((e, index) =>
      isNativeUserMessage(e) && !previousIds.includes(e.uuid)
        ? [{ e, index }]
        : [],
    );
    return {
      file: file.name,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      bytes: Buffer.byteLength(file.content),
      users: users.map(({ e, index }) => {
        let end = events.findIndex(
          (x, i) => i > index && isNativeUserMessage(x),
        );
        if (end < 0) end = events.length;
        const round = events.slice(index, end),
          pending = new Set();
        for (const x of round)
          for (const b of Array.isArray(x.message?.content)
            ? x.message.content
            : []) {
            if (x.type === 'assistant' && b.type === 'tool_use')
              pending.add(b.id);
            if (x.type === 'user' && b.type === 'tool_result')
              pending.delete(b.tool_use_id);
          }
        return {
          uuid: e.uuid,
          sessionId: e.sessionId,
          promptId: e.promptId,
          timestamp: e.timestamp,
          text: e.message.content,
          exactMatch: e.message.content === prompt,
          boundaryWhitespaceMatch: e.message.content.trim() === prompt.trim(),
          durationMarkers: round.filter(
            (x) => x.type === 'system' && x.subtype === 'turn_duration',
          ).length,
          pendingTools: pending.size,
        };
      }),
    };
  });
}
export function collectNativeDiagnosis(root, task, turn) {
  if (!task || !turn || turn.stage !== 'claude') return null;
  const work = path.join(root, '.runner'),
    s = readJSON(path.join(work, task.id, 'container.json'));
  if (
    !s ||
    s.taskId !== task.id ||
    s.questionId !== (turn.questionRootId || turn.id) ||
    s.pending?.turnId !== turn.id
  )
    return { error: '当前容器与本轮绑定不一致，未读取其他会话' };
  const runtime = new DockerRuntime(work);
  runtime.owned(s);
  const files = runtime.native(s);
  let screen = '';
  if (
    s.terminal?.logPath &&
    path
      .resolve(s.terminal.logPath)
      .startsWith(path.join(work, task.id) + path.sep)
  ) {
    const fd = fs.openSync(s.terminal.logPath, 'r');
    try {
      const size = fs.fstatSync(fd).size,
        b = Buffer.alloc(Math.min(size, 12000));
      fs.readSync(fd, b, 0, b.length, size - b.length);
      screen = b
        .toString('utf8')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .slice(-6000);
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    source: 'owned-container-read-only',
    containerId: s.containerId,
    questionId: s.questionId,
    pending: s.pending,
    native: summarizeNativeEvidence(files, turn.prompt, s.pending.previousIds),
    screenTail: screen,
    notice:
      '终端提示符和边界空白相同仅用于定位问题，不替代原生身份、完整归档与所有工具返回核验。原件未修改。',
  };
}
