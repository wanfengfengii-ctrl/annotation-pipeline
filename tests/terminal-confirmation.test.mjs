import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  localCommandDecision,
  terminalConfirmation,
} from '../lib/terminal-confirmation.mjs';
import { DockerRuntime } from '../scripts/docker-runtime.mjs';
const directory = 'projects/p-11111111-1111-4111-8111-111111111111';
const root = '/workspace/' + directory;
const command = `cd ${root} && mkdir -p var/manual && rm -f var/manual/* && \\\npython3 -m webhook_service receiver --receiver-port 18081 > var/manual/receiver.log 2>&1 &\nsleep 0.5\ncurl -s -X POST http://127.0.0.1:18080/webhooks -H 'X-Destination-Url: http://127.0.0.1:18081/success' --data-binary 'hello'; echo\nkill %1 %3 %4 2>/dev/null; cat var/manual/receiver.log`;
const screen =
  'Compound command contains cd with write operation - manual approval required\nto prevent path resolution bypass\nDo you want to proceed?\n❯ 1. Yes\n2. Yes, and don’t ask again\n3. No\nEsc to cancel · Tab to amend · ctrl+e to explain';
const events = [
  { type: 'user', uuid: 'prompt', message: { content: 'prepared prompt' } },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool', name: 'Bash', input: { command } },
      ],
    },
  },
];
const native = {
  complete: false,
  content: events.map((e) => JSON.stringify(e)).join('\n'),
};
test('只识别实际待处理工具和固定终端确认界面', () => {
  assert.equal(localCommandDecision(command, directory).allowed, true);
  assert.equal(terminalConfirmation(screen, native, directory).allowed, true);
  assert.equal(
    terminalConfirmation(
      screen.replace('❯ 1. Yes', '1. Yes'),
      native,
      directory,
    ),
    null,
  );
  assert.equal(
    terminalConfirmation(screen + '\nready', native, directory),
    null,
  );
  assert.equal(
    terminalConfirmation(screen, { ...native, complete: true }, directory),
    null,
  );
  assert.equal(
    terminalConfirmation(
      screen,
      {
        ...native,
        content:
          native.content +
          '\n' +
          JSON.stringify({
            message: {
              content: [{ type: 'tool_result', tool_use_id: 'tool' }],
            },
          }),
      },
      directory,
    ),
    null,
  );
});
test('越界删除、外部网络、发布和复杂 Shell 均不自动确认', () => {
  for (const cmd of [
    `cd ${root} && rm -rf /`,
    `cd ${root} && rm -f var/manual/../../src/main.py`,
    `cd ${root} && curl https://example.com`,
    `cd ${root} && curl -L http://localhost:1234`,
    `cd ${root} && curl -K config http://localhost:1234`,
    `cd ${root} && curl -d @secret http://localhost:1234`,
    `cd ${root} && curl --proxy http://localhost:8888 https://example.com`,
    `cd ${root} && git push`,
    `cd ${root} && gh issue comment 1 --body x`,
    `cd ${root} && ssh localhost`,
    `cd ${root} && npm publish`,
    `cd ${root} && python3 -c 'print(1)'`,
    `cd ${root} && node -e 'test'`,
    `cd ${root} && echo $(pwd)`,
    `cd ${root} && cat file > /tmp/out`,
    `cd ${root} && cat ~/.claude/settings.json`,
    `cd ${root} && npm --prefix=/tmp run test`,
  ])
    assert.equal(localCommandDecision(cmd, directory).allowed, false, cmd);
});
test('终端确认单次记账，重新轮询或重连不会重复回车，不新增用户题目', async () => {
  const rt = new DockerRuntime(
    mkdtempSync(path.join(tmpdir(), 'terminal-confirm-')),
  );
  const s = {
    taskId: '11111111-1111-4111-8111-111111111111',
    pending: { turnId: 'turn', previousIds: [] },
  };
  let writes = 0,
    reports = 0;
  rt.publish = async () => {
    reports++;
  };
  rt.owned = () => ({ State: { Running: true } });
  rt.permissionPreflight = () => ({ passed: true });
  rt.native = () => [{ content: native.content }];
  rt.live.set(s.taskId, {
    output: screen,
    child: {
      exitCode: null,
      stdin: {
        write: async (x) => {
          assert.equal(x, '\r');
          writes++;
        },
      },
    },
  });
  const task = { projectSeries: { directory } },
    turn = { id: 'turn', prompt: 'prepared prompt' };
  await rt.confirmLocalCommand(s, task, turn, native);
  await rt.confirmLocalCommand(s, task, turn, native);
  assert.equal(writes, 1);
  assert.equal(s.terminalConfirmations.tool.status, 'confirmed');
  assert.equal(reports, 2);
  assert.equal(s.pending.turnId, 'turn');
});
