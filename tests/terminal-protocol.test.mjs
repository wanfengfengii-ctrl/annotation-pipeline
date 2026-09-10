import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  terminalCommand,
  completeTerminal,
  terminalProtocolVersion,
} from '../scripts/mac-terminal.mjs';

test('legacy descriptors cannot masquerade as original-terminal final export', async () => {
  const legacy = { transport: 'mac-terminal', runId: 'old' };
  await assert.rejects(terminalCommand(legacy, { action: 'cp' }), /旧终端协议/);
  await assert.rejects(
    completeTerminal(legacy, { operationId: 'complete', containerId: 'old' }),
    /旧终端协议/,
  );
});

test('fake Docker in a real PTY verifies postprocessing, export identity and idempotent recovery', () => {
  const file = fileURLToPath(
    new URL('./fixtures/terminal-protocol.py', import.meta.url),
  );
  execFileSync('/usr/bin/python3', [file], {
    encoding: 'utf8',
    timeout: 45000,
  });
});

test('client waits for original bridge phase transition and recovers completed acknowledgement', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'terminal-phase-'));
  const d = {
    terminalProtocolVersion,
    runId: randomUUID(),
    statePath: path.join(dir, 'state.json'),
    socketPath: '/tmp/terminal-phase-' + randomUUID() + '.sock',
  };
  const writeState = (status, extra = {}) =>
    writeFileSync(
      d.statePath,
      JSON.stringify({
        runId: d.runId,
        terminalProtocolVersion,
        status,
        ...extra,
      }),
    );
  writeState('running');
  const received = [];
  const server = createServer((socket) => {
    socket.once('data', (bytes) => {
      received.push(JSON.parse(bytes));
      socket.end(
        JSON.stringify({
          ok: false,
          status: 'uncertain',
          receiptPath: '/receipt',
        }) + '\n',
      );
    });
  });
  await new Promise((resolve) => server.listen(d.socketPath, resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const timer = setTimeout(() => writeState('postprocessing'), 40);
  t.after(() => clearTimeout(timer));
  const result = await terminalCommand(d, {
    operationId: 'one',
    action: 'rm',
    containerId: 'a'.repeat(64),
    op: 'input',
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(received.length, 1);
  assert.equal(received[0].op, 'command');
  writeState('exited', {
    postprocessingComplete: true,
    containerId: 'a'.repeat(64),
    completeOperationId: 'complete-one',
  });
  assert.equal(
    (
      await completeTerminal(d, {
        operationId: 'complete-one',
        containerId: 'a'.repeat(64),
      })
    ).completed,
    true,
  );
  assert.equal(received.length, 1);
});
