import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertNativeSessionIdle,
  DockerRuntime,
} from '../scripts/docker-runtime.mjs';
import {
  exitCompletedTerminal,
  terminalExitReady,
  terminalOutput,
} from '../scripts/mac-terminal.mjs';

const ready =
  '❯ \n──────────────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const hint = '\nPress Ctrl-D again to exit\n';
const state = () => ({
  sessionId: 'session',
  results: {
    turn: {
      success: true,
      promptId: 'user',
      sessionId: 'session',
      traceExport: { verified: true },
    },
  },
});
const transcript = (complete = true) => [
  {
    name: 'session.jsonl',
    content:
      [
        {
          type: 'user',
          uuid: 'user',
          sessionId: 'session',
          message: { content: 'task' },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'done' }] },
        },
        ...(complete ? [{ type: 'system', subtype: 'turn_duration' }] : []),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
  },
];

test('native exit guard requires completed last actual user and a verified success receipt', () => {
  assert.deepEqual(assertNativeSessionIdle(state(), transcript()), {
    completedPromptIds: ['user'],
    empty: false,
  });
  assert.throws(
    () => assertNativeSessionIdle(state(), transcript(false)),
    /尚未确认完成/,
  );
  for (const pending of [
    { phase: 'sent' },
    { phase: 'reserved' },
    { phase: 'input_unconfirmed' },
  ])
    assert.throws(
      () => assertNativeSessionIdle({ ...state(), pending }, transcript()),
      /待确认或执行中/,
    );
  assert.throws(
    () => assertNativeSessionIdle({ ...state(), results: {} }, transcript()),
    /成功回执/,
  );
  const changed = state();
  changed.results.turn.traceExport.verified = false;
  assert.throws(
    () => assertNativeSessionIdle(changed, transcript()),
    /成功回执/,
  );
  assert.throws(() => assertNativeSessionIdle(state(), []), /原生会话缺失/);
});

test('a new user or tool activity after completion prevents EOF despite a stale success cache', () => {
  for (const event of [
    {
      type: 'user',
      uuid: 'new-user',
      sessionId: 'session',
      message: { content: 'more work' },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    },
  ]) {
    const files = transcript();
    files[0].content += JSON.stringify(event) + '\n';
    assert.throws(
      () => assertNativeSessionIdle(state(), files),
      /尚未确认完成/,
    );
  }
  assert.throws(
    () => assertNativeSessionIdle(state(), [{ content: '{bad json\n' }]),
    /损坏/,
  );
  const partial = transcript();
  partial[0].content += '{"type":"user"';
  assert.throws(
    () => assertNativeSessionIdle(state(), partial),
    /末行尚未写完/,
  );
  const sidechain = transcript();
  sidechain[0].content +=
    JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { content: [] },
    }) + '\n';
  assert.throws(
    () => assertNativeSessionIdle(state(), sidechain),
    /尚未确认完成/,
  );
});

test('empty unsent containers can exit but orphaned native activity cannot', () => {
  assert.deepEqual(assertNativeSessionIdle({ results: {} }, []), {
    completedPromptIds: [],
    empty: true,
  });
  assert.throws(
    () =>
      assertNativeSessionIdle({ results: {} }, [
        {
          content: JSON.stringify({
            type: 'assistant',
            message: { content: [] },
          }),
        },
      ]),
    /无法归属/,
  );
});

test('terminal readiness rejects busy, typed and unknown screens', () => {
  assert.equal(terminalExitReady(ready), true);
  assert.equal(
    terminalExitReady('\x1b]0;title\x07\x1b[2K' + ready + hint),
    true,
  );
  assert.equal(terminalExitReady(ready.replace('❯ ', '❯ unsent draft')), false);
  assert.equal(terminalExitReady(ready + ' · esc to interrupt'), false);
  assert.equal(terminalExitReady('root@container:/workspace# '), false);
  assert.equal(terminalExitReady(hint), false);
});

function terminalFixture(onWrite) {
  let time = 0,
    output = ready,
    running = true,
    safe = true;
  const inputs = [],
    scheduled = [];
  const f = {
    inputs,
    scheduled,
    append: (text) => {
      output += text;
    },
    stop: () => {
      running = false;
    },
    busy: () => {
      safe = false;
    },
    readOutput: (cursor) => ({
      cursor: output.length,
      text: cursor === undefined ? output : output.slice(cursor),
    }),
    write: async (data) => {
      inputs.push({ data, at: time });
      onWrite?.(f, inputs.length);
    },
    isRunning: () => running,
    assertIdle: () => {
      if (!safe) throw Error('native still running');
    },
    wait: async (ms) => {
      time += ms;
      for (const job of [...scheduled])
        if (job.at <= time) {
          scheduled.splice(scheduled.indexOf(job), 1);
          job.run();
        }
    },
    now: () => time,
    timeoutMs: 1500,
    maxInputs: 4,
  };
  return f;
}

test('exit waits for a fresh rendered confirmation and observes container exit', async () => {
  const f = terminalFixture((x, count) => {
    if (count === 1) x.scheduled.push({ at: 200, run: () => x.append(hint) });
    if (count === 2) x.scheduled.push({ at: 300, run: x.stop });
  });
  assert.deepEqual(await exitCompletedTerminal(f), {
    inputs: 2,
    confirmed: true,
  });
  assert.deepEqual(f.inputs, [
    { data: '\x04', at: 0 },
    { data: '\x04', at: 200 },
  ]);
});

test('stale prompts do not trigger blind repeated EOF and timeout preserves the running session', async () => {
  const f = terminalFixture();
  f.append(hint);
  await assert.rejects(exitCompletedTerminal(f), /已保留/);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.isRunning(), true);
});

test('expired confirmation can be rearmed only by another newly observed hint', async () => {
  const f = terminalFixture((x, count) => {
    if (count === 1) x.scheduled.push({ at: 900, run: () => x.append(hint) });
    if (count === 2) x.scheduled.push({ at: 1000, run: () => x.append(hint) });
    if (count === 3) x.scheduled.push({ at: 1100, run: x.stop });
  });
  assert.equal((await exitCompletedTerminal(f)).inputs, 3);
  assert.deepEqual(
    f.inputs.map((i) => i.at),
    [0, 900, 1000],
  );
});

test('guard is rechecked after confirmation before another key and unacknowledged input is never replayed', async () => {
  const f = terminalFixture((x) =>
    x.scheduled.push({
      at: 100,
      run: () => {
        x.append(hint);
        x.busy();
      },
    }),
  );
  await assert.rejects(exitCompletedTerminal(f), /native still running/);
  assert.equal(f.inputs.length, 1);
  const lost = terminalFixture();
  lost.write = async (data) => {
    lost.inputs.push(data);
    throw Error('input acknowledgement missing');
  };
  await assert.rejects(exitCompletedTerminal(lost), /acknowledgement missing/);
  assert.equal(lost.inputs.length, 1);
});

test('repeated fresh hints have a hard input budget and already stopped containers need no input', async () => {
  const f = terminalFixture((x) =>
    x.scheduled.push({ at: x.now() + 100, run: () => x.append(hint) }),
  );
  await assert.rejects(exitCompletedTerminal(f), /已保留/);
  assert.equal(f.inputs.length, 4);
  const stopped = terminalFixture();
  stopped.stop();
  assert.deepEqual(await exitCompletedTerminal(stopped), {
    inputs: 0,
    confirmed: true,
  });
});

test('a natural container exit racing native inspection is accepted only after a stopped observation', async () => {
  const f = terminalFixture();
  f.assertIdle = () => {
    f.stop();
    throw Error('docker exec container is not running');
  };
  assert.deepEqual(await exitCompletedTerminal(f), {
    inputs: 0,
    confirmed: true,
  });
  assert.equal(f.inputs.length, 0);
  const live = terminalFixture();
  live.assertIdle = () => {
    throw Error('docker exec unavailable');
  };
  await assert.rejects(exitCompletedTerminal(live), /docker exec unavailable/);
  assert.equal(live.inputs.length, 0);
  const afterHint = terminalFixture((x) =>
    x.scheduled.push({ at: 100, run: () => x.append(hint) }),
  );
  afterHint.assertIdle = () => {
    if (afterHint.inputs.length) {
      afterHint.stop();
      throw Error('container exited');
    }
  };
  assert.deepEqual(await exitCompletedTerminal(afterHint), {
    inputs: 1,
    confirmed: true,
  });
});

test('terminal cursor reads appended bytes and rejects truncation rather than reusing old exit text', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'terminal-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const d = { logPath: path.join(dir, 'screen.log') };
  writeFileSync(d.logPath, ready + hint);
  const first = terminalOutput(d);
  assert.equal(terminalOutput(d, first.cursor).text, '');
  appendFileSync(d.logPath, hint);
  assert.equal(terminalOutput(d, first.cursor).text, hint);
  writeFileSync(d.logPath, 'truncated');
  assert.throws(() => terminalOutput(d, first.cursor), /游标失效/);
});

test('Docker close refuses an unfinished native turn before attach, export or remove', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'container-close-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = randomUUID(),
    rt = new DockerRuntime(dir);
  rt.save({
    ...state(),
    taskId: id,
    containerId: 'owned',
    questionId: 'q',
    status: 'running',
  });
  rt.owned = () => ({ State: { Running: true } });
  rt.native = () => transcript(false);
  rt.attach = rt.export = () => {
    throw Error('unsafe operation should not happen');
  };
  rt.command = () => {
    throw Error('docker mutation should not happen');
  };
  await assert.rejects(rt.close(id), /尚未确认完成/);
  assert.equal(rt.load(id).status, 'running');
});
