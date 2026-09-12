import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failureKind } from '../lib/retry-policy.mjs';
import { assertDifficulty } from '../lib/task-policy.mjs';

export function supplyCredentialsRevision() {
  const root = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const stamps = ['auth.json', 'config.toml'].map((name) => {
    try {
      const s = statSync(path.join(root, name));
      return [name, s.mtimeMs, s.size];
    } catch {
      return [name, null];
    }
  });
  return createHash('sha256')
    .update(
      JSON.stringify([
        stamps,
        process.env.OPENAI_API_KEY || '',
        process.env.OPENAI_BASE_URL || '',
      ]),
    )
    .digest('hex');
}
export function wordingRepairAllowed(audit, draft) {
  const v = audit?.value;
  if (
    !v ||
    draft?.wordingRepair ||
    v.questionCompliant !== false ||
    v.matchedRuleIds?.length !== 0 ||
    v.duplicateTaskIds?.length !== 0
  )
    return false;
  try {
    assertDifficulty(v);
    return true;
  } catch {
    return false;
  }
}
export function supplyFailure(
  state,
  error,
  now = Date.now(),
  credentialsRevision = supplyCredentialsRevision(),
) {
  const kind = failureKind(error.message);
  state.failures = (state.failures || 0) + 1;
  const attempts =
    state.failure?.kind === kind ? state.failure.attempts + 1 : 1;
  const seconds =
    kind === 'transport'
      ? Math.min(300, 30 * 2 ** Math.min(4, attempts - 1))
      : kind === 'timeout'
        ? 60
        : 120;
  state.failure = {
    kind,
    attempts,
    at: new Date(now).toISOString(),
    action:
      kind === 'authentication'
        ? '等待认证配置更新'
        : state.draft
          ? '保留草稿，从失败步骤继续'
          : '重新准备候选',
  };
  if (kind === 'authentication')
    state.authPause = { credentialsRevision, reason: error.message };
  state.lastError = error.message;
  state.nextAt = now + seconds * 1000;
}
