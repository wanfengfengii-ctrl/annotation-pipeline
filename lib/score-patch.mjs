export const scorePatchVersion = '2026-09-12.score-patch1';
const object = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = { type: 'string', minLength: 1 };
export function scorePatchSchema({ fields }) {
  return object({
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: fields.length,
      items: object({
        field: { type: 'string', enum: fields },
        value: string,
      }),
    },
  });
}
export function applyScorePatch({ value, fields }, patch) {
  if (
    !patch ||
    Object.keys(patch).join() !== 'patches' ||
    !Array.isArray(patch.patches) ||
    !patch.patches.length
  )
    throw Error('评分补丁只能包含 patches，不能改动其他字段');
  const next = structuredClone(value),
    seen = new Set();
  for (const item of patch.patches) {
    if (
      !item ||
      Object.keys(item).sort().join() !== 'field,value' ||
      !fields.includes(item.field) ||
      seen.has(item.field) ||
      typeof item.value !== 'string' ||
      !item.value.trim()
    )
      throw Error('评分补丁不得改动分数、事实或未命中字段，也不能重复修改');
    seen.add(item.field);
    if (item.field === 'other') next.other = item.value;
    else {
      const match = /^(descriptions|evidenceRefs)\[([0-4])\]$/.exec(item.field);
      if (
        !match ||
        !Array.isArray(next[match[1]]) ||
        next[match[1]].length !== 5
      )
        throw Error('评分补丁字段无效');
      next[match[1]][Number(match[2])] = item.value;
    }
  }
  return next;
}
export function scoreWritingFields(issues) {
  return [
    ...new Set(
      issues.flatMap((issue) => {
        const match = /^(descriptions\[[0-4]\]|other)：/.exec(issue);
        return match ? [match[1]] : [];
      }),
    ),
  ];
}
