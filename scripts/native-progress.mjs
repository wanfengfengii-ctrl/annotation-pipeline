import { createHash } from 'node:crypto';

export const nativeObservationVersion = '2026-09-11.native-observation2';

// Only parsed records from the current native round can keep its observer alive.
// Terminal redraws, metadata and repeated reads of the same record do not count.
export class NativeProgressWatch {
  constructor(timeoutMs, startedAt = Date.now()) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw Error('原生会话静默超时必须是正数');
    this.timeoutMs = timeoutMs;
    this.lastProgressAt = startedAt;
    this.identity = null;
    this.seen = new Set();
    this.pendingTools = new Set();
    this.lastProgressKind = null;
  }

  diagnostics(now = Date.now()) {
    const silentMs = Math.max(0, now - this.lastProgressAt);
    return {
      version: nativeObservationVersion,
      silentMs,
      lastProgressAt: new Date(this.lastProgressAt).toISOString(),
      lastProgressKind: this.lastProgressKind,
      pendingTools: this.pendingTools.size,
      level:
        silentMs >= 1200000
          ? 'terminal-review-due'
          : silentMs >= 600000
            ? 'observe'
            : 'progressing',
      automaticResend: false,
      observationMode:
        silentMs >= this.timeoutMs ? 'waiting-native-completion' : 'active',
      pollIntervalMs: silentMs >= this.timeoutMs ? 15000 : 1500,
    };
  }
  observe(native, now = Date.now()) {
    if (native) {
      const identity = JSON.stringify([native.sessionId, native.promptId]);
      if (this.identity && this.identity !== identity)
        throw Error('观察中的原生会话或题目发生变化，保留容器');
      this.identity = identity;
      for (const line of native.content.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (
          event.isSidechain ||
          event.isApiErrorMessage ||
          event.subtype === 'api_error' ||
          (event.sessionId && event.sessionId !== native.sessionId) ||
          !Array.isArray(event.message?.content)
        )
          continue;
        const content = event.message.content.filter((block) =>
          event.type === 'assistant'
            ? (block.type === 'text' && !!block.text) ||
              (block.type === 'thinking' && !!block.thinking) ||
              block.type === 'tool_use'
            : event.type === 'user' && block.type === 'tool_result',
        );
        if (!content.length) continue;
        const key = createHash('sha256')
          .update(JSON.stringify([event.type, event.uuid, content]))
          .digest('hex');
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.lastProgressAt = now;
        this.lastProgressKind = event.type;
        for (const block of content) {
          if (block.type === 'tool_use') this.pendingTools.add(block.id);
          if (block.type === 'tool_result')
            this.pendingTools.delete(block.tool_use_id);
        }
      }
    }
    return now - this.lastProgressAt >= this.timeoutMs;
  }
}
