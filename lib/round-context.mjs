import { gatewayContinuationContext } from './gateway-continuation.mjs';
export const isContinuation = (prompt) =>
  /^(?:请)?(?:继续|继续完成|continue)[。.!！]*$/i.test((prompt || '').trim());

export function continuationContext(task, turn) {
  if (turn.gatewayContinuation) return gatewayContinuationContext(task, turn);
  const index = task.turns.findIndex((r) => r.id === turn.id);
  if (
    !turn.continuationOf &&
    !isContinuation(turn.requestedPrompt || turn.prompt)
  )
    return null;
  const previous = task.turns[index - 1];
  if (
    !previous ||
    previous.excluded ||
    !['review', 'submitted'].includes(previous.status) ||
    (turn.continuationOf && turn.continuationOf !== previous.id)
  )
    throw Error('继续必须关联紧邻的已完成有效轮次');
  return {
    previous,
    evaluationPrompt: previous.evaluationPrompt || previous.prompt,
    acceptance: previous.automation?.preparation?.value?.acceptance || [
      previous.evaluationPrompt || previous.prompt,
    ],
  };
}

export function continuationDecision(turn, reason) {
  return {
    prompt: '继续',
    continuationOf: turn.id,
    evaluationPrompt: turn.evaluationPrompt || turn.prompt,
    category: turn.category,
    difficulty: turn.difficulty,
    notice: reason,
  };
}

export function matchesNativePrompt(
  event,
  prompt,
  observedId,
  previousIds = [],
) {
  const content = event.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((x) => x.type === 'text')
            .map((x) => x.text)
            .join('')
        : '';
  return (
    event.type === 'user' &&
    !!event.uuid &&
    text === prompt &&
    (!observedId || event.uuid === observedId) &&
    !previousIds.includes(event.uuid)
  );
}
