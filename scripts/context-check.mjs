import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const requiredContextTokens = 1000000;
const contextKeys = [
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'DISABLE_COMPACT',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
];
export function checkClaudeContext({
  cwd,
  home = os.homedir(),
  env = process.env,
  resumeModel,
  managedPaths,
} = {}) {
  const files = [
    path.join(
      env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
      'settings.json',
    ),
    path.join(cwd || process.cwd(), '.claude', 'settings.json'),
    path.join(cwd || process.cwd(), '.claude', 'settings.local.json'),
    ...(managedPaths || [
      process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : '/etc/claude-code/managed-settings.json',
    ]),
  ];
  let settings = {},
    effectiveEnv = { ...env };
  const sources = [],
    errors = [];
  for (const file of [...new Set(files)]) {
    if (!existsSync(file)) continue;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('invalid');
      settings = { ...settings, ...value };
      effectiveEnv = { ...effectiveEnv, ...value.env };
      sources.push(file);
    } catch {
      errors.push('配置文件无法解析：' + file);
    }
  }
  const model = String(
    effectiveEnv.ANTHROPIC_MODEL || settings.model || resumeModel || '',
  );
  const family = /^(opus|sonnet|haiku)(?:\[1m\])?$/i.exec(model);
  const resolved = family
    ? String(
        effectiveEnv[
          'ANTHROPIC_DEFAULT_' + family[1].toUpperCase() + '_MODEL'
        ] || model,
      )
    : model;
  const configured = Object.fromEntries(
    contextKeys
      .filter((k) => effectiveEnv[k] !== undefined)
      .map((k) => [k, String(effectiveEnv[k])]),
  );
  const disabled = ['1', 'true'].includes(
    String(effectiveEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT).toLowerCase(),
  );
  const custom =
    !!resolved &&
    !/claude|^(opus|sonnet|haiku|default|best|fable)(?:\[1m\])?$/i.test(
      resolved,
    );
  const declared = Number(effectiveEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
  let tokens = null,
    reason = '当前 CLI 没有可核验的 100 万上下文配置，请按项目方配置脚本核对';
  if (
    custom &&
    !/\[1m\]/i.test(resolved) &&
    Number.isSafeInteger(declared) &&
    declared > 0
  )
    tokens = declared;
  else if (/\[1m\]/i.test(model + ' ' + resolved) && !disabled)
    tokens = requiredContextTokens;
  else if (
    !custom &&
    ['1', 'true'].includes(
      String(effectiveEnv.DISABLE_COMPACT).toLowerCase(),
    ) &&
    Number.isSafeInteger(declared) &&
    declared > 0
  )
    tokens = declared;
  if (disabled) {
    tokens = null;
    reason = '检测到限制 1M 上下文的设置，需要核对项目方配置';
  }
  if (tokens !== null)
    reason =
      tokens === requiredContextTokens
        ? '客户端已声明 100 万上下文，网关真实容量尚未实测'
        : `客户端声明 ${tokens} tokens，与规范要求的 1000000 不一致`;
  if (!model) reason = '无法确定 CLI 当前配置模型，请先完成模型配置';
  if (errors.length) reason = errors.join('；');
  const ready =
    !!model && tokens === requiredContextTokens && !disabled && !errors.length;
  return {
    version: '2026-09-09.context1',
    harness: 'Claude Code',
    ready,
    status: ready ? 'configured' : tokens === null ? 'unverified' : 'mismatch',
    requiredTokens: requiredContextTokens,
    configuredTokens: tokens,
    model,
    sources,
    settings: configured,
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          model,
          resolved,
          selectedModel: settings.model,
          configured,
          baseUrl: effectiveEnv.ANTHROPIC_BASE_URL || '',
          sources,
        }),
      )
      .digest('hex'),
    checkedAt: new Date().toISOString(),
    reason,
    gateway: 'unverified',
    note: '这里只核对客户端声明，不把配置数值当作网关容量证明，也不把自动压缩阈值当作上下文窗口。',
  };
}
export function assertContext(check) {
  if (!check?.ready)
    throw Error('上下文预检未通过：' + (check?.reason || '缺少检查结果'));
}
export function assertContextContinuity(check, turns) {
  const previous = turns
    .filter((r) => r.contextCheck && (r.claudeAttempts?.length || r.promptId))
    .at(-1)?.contextCheck;
  if (previous && previous.fingerprint !== check.fingerprint)
    throw Error(
      'CLI 配置已变化，请结束原会话并新建任务，保留原会话的模型与环境',
    );
}
export function runtimeContextCheck(check, result, model) {
  const usages = Object.entries(result?.modelUsage || {}),
    active = usages.find(([name]) => name === model);
  const reported =
    active?.[1]?.contextWindow ??
    (usages.length === 1 ? usages[0][1]?.contextWindow : undefined);
  const runtimeTokens = Number.isSafeInteger(reported) ? reported : null;
  const mismatch =
    runtimeTokens !== null && runtimeTokens !== requiredContextTokens;
  return {
    ...check,
    runtimeTokens,
    runtimeStatus: mismatch
      ? 'mismatch'
      : runtimeTokens === null
        ? 'unreported'
        : 'reported',
    ready: check.ready && !mismatch,
    reason: mismatch
      ? `CLI 本轮报告 ${runtimeTokens} tokens，与要求的 1000000 不一致`
      : check.reason,
    note: check.note + ' CLI 运行报告仍不代表已用百万 token 实测网关。',
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const value = checkClaudeContext({
    cwd: path.resolve(process.argv[2] || process.cwd()),
  });
  console.log(JSON.stringify(value, null, 2));
  if (!value.ready) process.exitCode = 2;
}
