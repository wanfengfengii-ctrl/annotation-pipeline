import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  dockerSnapshot,
  validDockerSnapshot,
  containerCapacity,
  containerImage,
  containerPolicyVersion,
} from '../lib/container-policy.mjs';
import {
  DockerRuntime,
  readNativeTurn,
  sameManifest,
} from '../scripts/docker-runtime.mjs';
const imageId = 'sha256:' + 'a'.repeat(64);
const events = (prompt, id = 'user', complete = true) => [
  {
    type: 'user',
    uuid: id,
    sessionId: 'session',
    message: { content: prompt },
  },
  {
    type: 'assistant',
    message: {
      model: 'configured',
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'thinking' }],
    },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'tool output' }] },
  },
  {
    type: 'assistant',
    message: {
      model: 'configured',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
    },
  },
  ...(complete ? [{ type: 'system', subtype: 'turn_duration' }] : []),
];
const files = (es) => [
  { content: es.map((e) => JSON.stringify(e)).join('\n') },
];
test('Docker resource budget uses VM memory and zero when unavailable', () => {
  assert.equal(
    containerCapacity({ ready: true, cpus: 10, memoryBytes: 8217059328 }, 3),
    1,
  );
  assert.equal(containerCapacity({ ready: false }, 3), 0);
  assert.equal(
    containerCapacity({ ready: true, cpus: 8, memoryBytes: 16 * 2 ** 30 }, 3),
    3,
  );
  assert.equal(
    containerCapacity({ ready: true, cpus: 2, memoryBytes: 4 * 2 ** 30 }, 3),
    0,
  );
  assert.equal(validDockerSnapshot(dockerSnapshot(imageId)), true);
  assert.equal(validDockerSnapshot('docker://other@' + imageId), false);
});
test('Native completion needs turn_duration, preserves real IDs and ignores tool results', () => {
  assert.equal(
    readNativeTurn(files(events('hello', 'u1', false)), 'hello').complete,
    false,
  );
  const r = readNativeTurn(files(events('hello', 'u1')), 'hello');
  assert.equal(r.complete, true);
  assert.equal(r.promptId, 'u1');
  assert.equal(r.sessionId, 'session');
  assert.equal(r.output, 'done');
  assert.equal(
    readNativeTurn(files(events('hello', 'u1')), 'hello', ['u1']),
    null,
  );
  assert.equal(readNativeTurn(files(events('other', 'u1')), 'hello'), null);
  assert.equal(
    sameManifest([{ name: 'a', sha256: 'x' }], [{ name: 'a', sha256: 'y' }]),
    false,
  );
});
class Fake extends DockerRuntime {
  async ensure(task) {
    let s = this.load(task.id);
    if (!s) {
      s = {
        taskId: task.id,
        workDir: path.join(this.root, task.id, 'workspace'),
        results: {},
        status: 'running',
      };
      mkdirSync(s.workDir, { recursive: true });
      this.save(s);
    }
    return s;
  }
  owned() {
    return { State: { Running: true } };
  }
  native() {
    return this.current || [];
  }
  async export() {
    if (this.failExport) throw Error('export mismatch');
    return { verified: true, files: 1 };
  }
  permissionAudit() {
    return { passed: true };
  }
  async publish(s) {
    this.save(s);
  }
}
test('Ten prompts use one session; cache/export retries never send an extra prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'container-unit-')),
    rt = new Fake(root),
    task = { id: randomUUID() };
  let writes = 0,
    reserves = 0;
  rt.live.set(task.id, {
    child: {
      stdin: {
        write(data) {
          if (data === '\r') return;
          writes++;
          const prompt = data.slice(6, -6);
          rt.current = files(events(prompt, 'u' + writes));
        },
      },
    },
  });
  const reserve = async () => ({ allowed: ++reserves <= 10, count: reserves });
  let first;
  for (let i = 0; i < 10; i++) {
    const turn = { id: randomUUID(), prompt: 'prompt ' + i };
    first ||= turn;
    const result = await rt.execute(task, turn, reserve);
    assert.equal(result.sessionId, 'session');
    assert.equal(result.promptId, 'u' + (i + 1));
  }
  await rt.execute(task, first, reserve);
  assert.equal(writes, 10);
  assert.equal(reserves, 10);
  await assert.rejects(
    rt.execute(task, { id: randomUUID(), prompt: 'eleventh' }, reserve),
    /10/,
  );
});
test('Export failure retains original pending prompt and retries only export', async () => {
  const rt = new Fake(mkdtempSync(path.join(tmpdir(), 'export-retry-'))),
    task = { id: randomUUID() },
    turn = { id: randomUUID(), prompt: 'original' };
  let sends = 0,
    reserves = 0;
  rt.live.set(task.id, {
    child: {
      stdin: {
        write(d) {
          if (d === '\r') return;
          sends++;
          rt.current = files(events('original'));
        },
      },
    },
  });
  rt.failExport = true;
  await assert.rejects(
    rt.execute(task, turn, async () => ({ allowed: true, count: ++reserves })),
    /export mismatch/,
  );
  rt.failExport = false;
  await rt.execute(task, turn, async () => ({
    allowed: true,
    count: ++reserves,
  }));
  assert.equal(sends, 1);
  assert.equal(reserves, 1);
  await assert.rejects(
    rt.execute(
      task,
      { id: randomUUID(), prompt: 'bad\x1bcommand' },
      async () => ({ allowed: true }),
    ),
    /控制字符/,
  );
});
test('Cleanup never removes a container before a verified full export', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-unit-')),
    commands = [];
  const rt = new DockerRuntime(
    root,
    async () => {},
    () => false,
    (args) => {
      commands.push(args);
      return '';
    },
  );
  const taskId = randomUUID(),
    workDir = path.join(root, taskId, 'workspace');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path.join(workDir, 'code.txt'), 'keep');
  const s = {
    taskId,
    name: 'annotation-' + taskId,
    containerId: 'owned',
    workDir,
    status: 'stopped',
    results: {},
    image: containerImage,
    imageId,
    snapshot: dockerSnapshot(imageId),
    policyVersion: containerPolicyVersion,
  };
  rt.save(s);
  rt.owned = () => ({ State: { Running: false } });
  rt.export = async () => {
    throw Error('hash mismatch');
  };
  await assert.rejects(rt.close(taskId), /hash mismatch/);
  assert.equal(commands.length, 0);
  rt.export = async () => ({ verified: true, path: '/traces' });
  await rt.close(taskId);
  assert.deepEqual(commands, [['rm', 'owned']]);
  assert.equal(rt.load(taskId).status, 'removed');
  assert.equal(readFileSync(path.join(workDir, 'code.txt'), 'utf8'), 'keep');
});

test('Cleanup acknowledgement recovery does not block other projects', async () => {
  const rt = new DockerRuntime(
    mkdtempSync(path.join(tmpdir(), 'cleanup-sync-')),
  );
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of ids.entries())
    rt.save({ taskId: id, status: i === 2 ? 'removed' : 'stopped' });
  const closed = [],
    reported = [];
  rt.close = async (id) => {
    closed.push(id);
    if (id === ids[0]) throw Error('export not ready');
  };
  rt.report = async (s) => reported.push(s.taskId);
  const tasks = ids.map((id) => ({
    id,
    closed: true,
    containerStatus: 'exported',
  }));
  await rt.reconcile(tasks);
  assert.deepEqual(closed, ids.slice(0, 2));
  assert.deepEqual(reported, [ids[2]]);
  await rt.reconcile(tasks);
  assert.equal(
    closed.length,
    2,
    'failed cleanup uses a bounded retry interval',
  );
});

test('Partial final JSONL writes are ignored until complete, malformed complete lines fail', () => {
  const base = files(events('hello', 'u1', false))[0].content + '\n';
  assert.equal(
    readNativeTurn([{ content: base + '{"type":' }], 'hello').complete,
    false,
  );
  assert.throws(
    () => readNativeTurn([{ content: base + '{"type":\n' }], 'hello'),
    /损坏/,
  );
  assert.equal(
    validDockerSnapshot(dockerSnapshot(imageId) + '@' + imageId),
    false,
  );
});
