import { createHash } from 'node:crypto';
import { isNativeUserMessage } from '../lib/native-user-message.mjs';

// Only a final native API-error event can authorize another user message.
// HTTP status text emitted by a tool or mentioned in normal prose is not one.
export function completedGateway504(events) {
  const duration = events.findLastIndex(
    (e) =>
      !e.isSidechain && e.type === 'system' && e.subtype === 'turn_duration',
  );
  if (
    duration < 0 ||
    events
      .slice(duration + 1)
      .some((e) => e.type === 'assistant' || isNativeUserMessage(e))
  )
    return null;
  const assistants = events
    .slice(0, duration)
    .filter((e) => !e.isSidechain && e.type === 'assistant');
  const last = assistants.at(-1);
  if (!last || last.isApiErrorMessage !== true || last.error !== 'server_error')
    return null;
  const text = (last.message?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (
    ![last.status, last.statusCode, last.error?.status].includes(504) &&
    !/(?:API Error|HTTP(?: status)?|status(?: code)?)\s*[:=]?\s*504\b|^\s*504\s+Gateway\s+Time[- ]?out/im.test(
      text,
    )
  )
    return null;
  const blocks = events
    .slice(0, duration)
    .filter((e) => !e.isSidechain)
    .flatMap((e) =>
      Array.isArray(e.message?.content) ? e.message.content : [],
    );
  const uses = blocks.filter((b) => b.type === 'tool_use');
  if (
    new Set(uses.map((b) => b.id)).size !== uses.length ||
    uses.some(
      (b) =>
        !b.id ||
        !blocks.some(
          (r, i) =>
            i > blocks.indexOf(b) &&
            r.type === 'tool_result' &&
            r.tool_use_id === b.id,
        ),
    ) ||
    blocks.some(
      (b) =>
        b.type === 'tool_result' && !uses.some((u) => u.id === b.tool_use_id),
    )
  )
    return null;
  return {
    status: 504,
    eventSha256: createHash('sha256')
      .update(JSON.stringify(last))
      .digest('hex'),
  };
}
