import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evidencePath } from './evidence.mjs';
import { validateRuntimePlan } from '../lib/runtime-verification.mjs';
import { runtimeSuiteCheckSchema } from '../lib/runtime-suite.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const version = '2026-09-12.plan-checkpoint1';
export function saveRuntimePlan(dir, identity, plan) {
  const file = path.join(
    dir,
    'runtime-plan-' + randomUUID() + '.checkpoint.json',
  );
  const bytes = JSON.stringify({
    version,
    identity,
    plan,
    traceSha256: hash(fs.readFileSync(plan.tracePath)),
  });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return { path: file, sha256: hash(bytes) };
}
export function readRuntimePlan(receipt, dir, identity) {
  try {
    const bytes = fs.readFileSync(evidencePath(receipt.path, dir));
    if (hash(bytes) !== receipt.sha256) return null;
    const value = JSON.parse(bytes);
    if (
      value.version !== version ||
      JSON.stringify(value.identity) !== JSON.stringify(identity) ||
      hash(fs.readFileSync(evidencePath(value.plan.tracePath, dir))) !==
        value.traceSha256
    )
      return null;
    validateRuntimePlan(value.plan.value);
    return value.plan;
  } catch {
    return null;
  }
}
export function runtimeRepairSchema(base) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'replace'],
    properties: {
      summary: { type: 'string' },
      replace: {
        type: 'array',
        maxItems: base.ids.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'check'],
          properties: {
            reason: { type: 'string', minLength: 1 },
            check: runtimeSuiteCheckSchema,
          },
        },
      },
    },
  };
}
export function applyRuntimeStepRepair(base, patch) {
  if (
    !patch ||
    typeof patch.summary !== 'string' ||
    !patch.summary.trim() ||
    !Array.isArray(patch.replace) ||
    Object.keys(patch).sort().join() !== 'replace,summary'
  )
    throw Error('续跑计划只能说明摘要并修订阻塞步骤');
  const checks = new Map(base.plan.value.checks.map((c) => [c.id, c])),
    seen = new Set();
  for (const entry of patch.replace) {
    const c = entry?.check,
      prior = checks.get(c?.id);
    if (
      !prior ||
      !base.ids.includes(c.id) ||
      seen.has(c.id) ||
      !entry.reason?.trim() ||
      c.kind !== prior.kind
    )
      throw Error('续跑计划不能改动已完成步骤、删除检查或修改类型');
    seen.add(c.id);
    checks.set(c.id, c);
  }
  return validateRuntimePlan({
    ...base.plan.value,
    summary: patch.summary,
    checks: [...checks.values()],
  });
}
