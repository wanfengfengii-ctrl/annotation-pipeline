// A project is a grouping, not a Claude session. Only explicit continuations share a session.
export function questionRoot(task, turn) {
  if (turn.questionRootId) return turn.questionRootId;
  if (!turn.repairOf && !turn.continuationOf) return turn.id;
  const previous = task.turns?.find(
    (r) => r.id === (turn.repairOf || turn.continuationOf),
  );
  if (!previous) throw Error('继续原题缺少前序轮次');
  const visited = new Set([turn.id]);
  let current = previous;
  while (
    (current.repairOf || current.continuationOf) &&
    !current.questionRootId
  ) {
    if (visited.has(current.id)) throw Error('原题引用存在循环');
    visited.add(current.id);
    current = task.turns.find(
      (r) => r.id === (current.repairOf || current.continuationOf),
    );
    if (!current) throw Error('原题引用缺失');
  }
  return current.questionRootId || current.id;
}
export function priorQuestionTurn(task, turn) {
  const index = task.turns?.findIndex((r) => r.id === turn.id) ?? -1;
  return (index < 0 ? [] : task.turns.slice(0, index))
    .filter((r) => !r.excluded && ['review', 'submitted'].includes(r.status))
    .at(-1);
}
