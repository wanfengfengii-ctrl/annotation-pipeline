import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkClaudeContext,
  assertContext,
  assertContextContinuity,
  runtimeContextCheck,
} from '../scripts/context-check.mjs';
import { codexTurnIds, harnessInstructions } from '../lib/harness.mjs';

test('模型切换覆盖失败调用重试，尚未调用的预检失败可修正配置', () => {
  const check = { fingerprint: 'new' };
  const previous = { contextCheck: { fingerprint: 'old' } };
  assert.doesNotThrow(() => assertContextContinuity(check, [previous]));
  assert.throws(
    () =>
      assertContextContinuity(check, [
        { ...previous, claudeAttempts: [{ id: 'failed-attempt' }] },
      ]),
    /配置已变化/,
  );
  assert.throws(
    () =>
      assertContextContinuity(check, [{ ...previous, promptId: 'native-id' }]),
    /配置已变化/,
  );
  assert.doesNotThrow(() =>
    assertContextContinuity(check, [
      { contextCheck: check, claudeAttempts: [{ id: 'same' }] },
    ]),
  );
});

function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'context-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  const write = (value, target = path.join(home, '.claude/settings.json')) =>
    writeFileSync(target, JSON.stringify(value));
  const check = (extra = {}) =>
    checkClaudeContext({ home, cwd, env: {}, managedPaths: [], ...extra });
  return { home, cwd, write, check };
}
test('自定义模型每次重读配置，压缩阈值不是上下文窗口', (t) => {
  const f = fixture(t);
  f.write({
    model: 'custom-a',
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
  });
  assert.equal(f.check().status, 'unverified');
  assert.throws(() => assertContext(f.check()), /上下文预检/);
  f.write({
    model: 'custom-a',
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000' },
  });
  assert.equal(f.check().status, 'mismatch');
  f.write({
    model: 'custom-a',
    env: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_BASE_URL: 'https://private.invalid',
    },
  });
  const a = f.check();
  assert.equal(a.ready, true);
  assert.equal(a.gateway, 'unverified');
  assert.ok(!JSON.stringify(a).includes('secret'));
  assert.ok(!JSON.stringify(a).includes('private.invalid'));
  f.write({
    model: 'custom-b',
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' },
  });
  const b = f.check({ resumeModel: 'custom-a' });
  assert.equal(b.model, 'custom-b');
  assert.notEqual(a.fingerprint, b.fingerprint);
});
test('项目与受管配置覆盖，全局模型别名和上下文禁用规则', (t) => {
  const f = fixture(t);
  f.write({ model: 'sonnet[1m]' });
  assert.equal(f.check({ resumeModel: 'claude-sonnet-reported' }).ready, true);
  f.write(
    { env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } },
    path.join(f.cwd, '.claude/settings.local.json'),
  );
  assert.equal(f.check().ready, false);
  f.write(
    {
      model: 'custom-local',
      env: {
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '0',
      },
    },
    path.join(f.cwd, '.claude/settings.local.json'),
  );
  assert.equal(f.check().ready, true);
  const managed = path.join(f.home, 'managed.json');
  f.write({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000' } }, managed);
  assert.equal(f.check({ managedPaths: [managed] }).status, 'mismatch');
  writeFileSync(managed, 'invalid json');
  assert.equal(f.check({ managedPaths: [managed] }).ready, false);
});
test('CLI 运行报告冲突会阻止评分，缺少报告不会伪造网关实测', (t) => {
  const f = fixture(t);
  f.write({
    model: 'custom-a',
    env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000' },
  });
  const a = f.check();
  assert.equal(
    runtimeContextCheck(
      a,
      { modelUsage: { 'custom-a': { contextWindow: 200000 } } },
      'custom-a',
    ).ready,
    false,
  );
  assert.equal(
    runtimeContextCheck(
      a,
      { modelUsage: { 'custom-a': { contextWindow: 1000000 } } },
      'custom-a',
    ).runtimeStatus,
    'reported',
  );
  const noReport = runtimeContextCheck(a, {}, 'custom-a');
  assert.equal(noReport.runtimeStatus, 'unreported');
  assert.equal(noReport.gateway, 'unverified');
});
test('Codex 原生 TurnID 只取 task_started，规划点评不绑定工具名', () => {
  assert.deepEqual(
    codexTurnIds([
      { type: 'thread.started', thread_id: 'wrong' },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-a' },
      },
      { type: 'task_started', turn_id: 'turn-a' },
      { type: 'task_started', turn_id: 'turn-b' },
    ]),
    ['turn-a', 'turn-b'],
  );
  assert.match(harnessInstructions('Codex CLI'), /被测客户端是 Codex CLI/);
  assert.match(harnessInstructions(), /不因是否调用特定规划工具而加减分/);
});
