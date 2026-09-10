// Runs the actual route with an in-memory store. No server, Docker or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { questionRoot } from '../lib/question-session.mjs';
import { submissionIssues } from '../lib/submission-policy.mjs';

const source = (file) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
const storeCode = source('../db/store.ts'),
  routeCode = source('../app/api/runner/route.ts');
const digest = (letter) => letter.repeat(64);
const checked = '2026-09-10T12:00:00.000Z';

function fixture(change = () => {}) {
  const initial = {
    task: {
      id: 'task-fixture',
      closed: false,
      exportedCount: 2,
      snapshot: 'original snapshot',
      turns: [
        {
          id: 'turn-fixture',
          questionRootId: 'turn-fixture',
          sessionId: 'session-fixture',
          status: 'review',
          prompt: 'original prompt',
          output: 'original output',
          original: { retained: true },
          review: {
            source: 'codex',
            scores: [2, 3, 4, 5, 4],
            descriptions: ['a', 'b', 'c', 'd', 'e'],
          },
          container: {
            questionId: 'turn-fixture',
            containerId: digest('a'),
            terminalIdentity: { runId: 'run-fixture' },
          },
          automation: {
            archive: {
              archivePath: '/fixture/original.tar.gz',
              sha256: digest('b'),
            },
            score: { value: { unchanged: true } },
            next: { action: 'finish' },
          },
        },
        { id: 'next-turn', status: 'queued', prompt: 'next prompt' },
      ],
    },
    revision: 7,
  };
  change(initial);
  let saved = structuredClone(initial),
    saves = 0,
    reads = 0;
  function evaluate(code, require) {
    const exports = {};
    runInNewContext(code, {
      exports,
      require,
      Response,
      Request,
      Error,
      Date,
      crypto: globalThis.crypto,
    });
    return exports;
  }
  const store = evaluate(storeCode, (name) => {
    assert.equal(name, 'cloudflare:workers');
    return { env: { RUNNER_TOKEN: 'synthetic-fixture-only' } };
  });
  Object.assign(store, {
    async get(id) {
      reads++;
      return id === saved.task.id ? structuredClone(saved) : null;
    },
    async save(task, revision) {
      assert.equal(revision, saved.revision);
      saves++;
      saved = { task: structuredClone(task), revision: revision + 1 };
    },
    db() {
      assert.fail(
        'submission metadata must not update SQL counters or other tables',
      );
    },
    all() {
      assert.fail('submission metadata must not enumerate or schedule tasks');
    },
  });
  const { POST } = evaluate(routeCode, (name) => {
    if (name === '@/db/store') return store;
    if (name === '@/lib/question-session.mjs') return { questionRoot };
    return new Proxy(
      {},
      { get: () => () => assert.fail('unrelated route dependency invoked') },
    );
  });
  const finalization = {
    version: '2026-09-10.terminal-finalization1',
    taskId: 'task-fixture',
    questionId: 'turn-fixture',
    runId: 'run-fixture',
    sessionId: 'session-fixture',
    containerId: digest('a'),
    status: 'removed',
    commandTransport: 'original-mac-terminal',
    traceExport: {
      verified: true,
      exportKind: 'final',
      path: '/fixture/turn-fixture.final.traces-x/projects',
      manifestPath: '/fixture/turn-fixture.final.traces-x/manifest.json',
      files: 1,
      sha256: digest('c'),
    },
    manifestSha256: digest('d'),
    removedAt: checked,
    receiptPath: '/fixture/questions/turn-fixture/terminal/finalization.json',
    receiptSha256: digest('e'),
  };
  const submission = {
    version: '2026-09-10.submission1',
    status: 'passed',
    sourceArchiveSha256: digest('b'),
    archivePath: '/fixture/submission.tar.gz',
    sha256: digest('f'),
    manifestPath: '/fixture/submission/manifest.json',
    manifestSha256: digest('1'),
    zipArchivePath: '/fixture/submission.zip',
    zipSha256: digest('2'),
    zipBytes: 256,
    traceExportSha256: digest('c'),
    verifiedAt: checked,
    files: 1,
    redactions: [{ kind: 'known-secret', count: 1 }],
    reviewRequiredFiles: [],
    finalization,
  };
  const body = {
    action: 'submission-package',
    taskId: 'task-fixture',
    turnId: 'turn-fixture',
    sourceArchiveSha256: digest('b'),
    submission,
  };
  return {
    initial,
    body,
    store,
    state: () => structuredClone(saved),
    saves: () => saves,
    reads: () => reads,
    async call(input = body, authenticated = true) {
      const response = await POST(
        new Request('https://fixture.invalid/api/runner', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authenticated
              ? { authorization: 'Bearer synthetic-fixture-only' }
              : {}),
          },
          body: JSON.stringify(input),
        }),
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

test('runner authentication precedes any task read or update', async () => {
  const f = fixture();
  assert.equal((await f.call(f.body, false)).status, 400);
  assert.equal(f.reads(), 0);
  assert.equal(f.saves(), 0);
});

test('metadata-only backfill preserves score, original archive, task state and counters', async () => {
  for (const status of ['review', 'failed']) {
    const f = fixture((state) => {
      state.task.turns[0].status = status;
    });
    const expected = structuredClone(f.initial);
    expected.task.turns[0].automation.submission = f.body.submission;
    expected.revision++;
    assert.deepEqual(
      await f.call({
        ...f.body,
        status: 'submitted',
        review: { scores: [] },
        archive: {},
        score: {},
        original: {},
      }),
      { status: 200, body: { ok: true } },
    );
    assert.deepEqual(f.state(), expected);
    assert.equal(f.saves(), 1);
  }
});

test('same manifest retry does not update revision or replace the first receipt', async () => {
  const f = fixture();
  assert.equal((await f.call()).status, 200);
  const before = f.state();
  f.body.submission.verifiedAt = '2026-09-10T12:01:00.000Z';
  assert.deepEqual(await f.call(), {
    status: 200,
    body: { ok: true, duplicate: true },
  });
  assert.deepEqual(f.state(), before);
  assert.equal(f.saves(), 1);
});

test('unscored, running, queued and submitted turns cannot be backfilled', async () => {
  for (const change of [
    (turn) => {
      delete turn.review;
    },
    (turn) => {
      turn.review.scores = [5];
    },
    ...['queued', 'running', 'submitted'].map((status) => (turn) => {
      turn.status = status;
    }),
  ]) {
    const f = fixture((state) => change(state.task.turns[0]));
    assert.equal((await f.call()).status, 400);
    assert.deepEqual(f.state(), f.initial);
    assert.equal(f.saves(), 0);
  }
});

test('both request and submission must match the existing source archive digest', async () => {
  for (const change of [
    (body) => {
      body.sourceArchiveSha256 = digest('9');
    },
    (body) => {
      body.submission.sourceArchiveSha256 = digest('9');
    },
    (body) => {
      body.sourceArchiveSha256 = 'invalid';
    },
  ]) {
    const f = fixture();
    change(f.body);
    assert.equal((await f.call()).status, 400);
    assert.equal(f.saves(), 0);
  }
  const missing = fixture((state) => {
    delete state.task.turns[0].automation.archive;
  });
  assert.equal((await missing.call()).status, 400);
});

test('final completion metadata binds task, root question, original container and Terminal', async () => {
  const changes = [
    (v) => {
      v.taskId = 'other-task';
    },
    (v) => {
      v.questionId = 'other-turn';
    },
    (v) => {
      v.containerId = digest('9');
    },
    (v) => {
      v.runId = 'other-run';
    },
    (v) => {
      v.sessionId = 'other-session';
    },
    (v) => {
      delete v.sessionId;
    },
    (v) => {
      v.status = 'stopped';
    },
    (v) => {
      v.receiptSha256 = 'invalid';
    },
    (v) => {
      v.receiptPath =
        '/fixture/questions/other-turn/terminal/finalization.json';
    },
    (v) => {
      v.traceExport.verified = false;
    },
    (v) => {
      v.traceExport.exportKind = 'intermediate';
    },
    (v) => {
      v.traceExport.sha256 = digest('9');
    },
    (v) => {
      v.removedAt = 'invalid';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.body.submission.finalization);
    assert.equal((await f.call()).status, 400);
    assert.equal(f.saves(), 0);
  }
});

test('Bug rounds bind the root container while retaining their own turn metadata', async () => {
  const f = fixture((state) => {
    state.task.turns[0].questionRootId = 'prior-root';
    state.task.turns[0].container.questionId = 'prior-root';
  });
  f.body.submission.finalization.questionId = 'prior-root';
  f.body.submission.finalization.receiptPath =
    '/fixture/questions/prior-root/terminal/finalization.json';
  assert.equal((await f.call()).status, 200);
  assert.equal(f.state().task.turns[0].id, 'turn-fixture');
});

test('missing finalization is accepted only for awaiting or blocked metadata', async () => {
  for (const status of [
    'passed',
    'needs_review',
    'awaiting_finalization',
    'blocked',
  ]) {
    const f = fixture();
    f.body.submission.status = status;
    delete f.body.submission.finalization;
    if (status === 'blocked') {
      delete f.body.submission.manifestSha256;
      delete f.body.submission.zipSha256;
    }
    assert.equal(
      (await f.call()).status,
      ['awaiting_finalization', 'blocked'].includes(status) ? 200 : 400,
    );
  }
});

test('legacy migration keeps needs_review and cannot claim passed', async () => {
  const f = fixture();
  f.body.submission.finalization.commandTransport = 'legacy-runner-migration';
  assert.equal((await f.call()).status, 400);
  f.body.submission.status = 'needs_review';
  assert.equal((await f.call()).status, 200);
});

test('old legacy final directories register unchanged review metadata without opening delivery', async () => {
  const legacy = () => {
    const f = fixture();
    const final = f.body.submission.finalization;
    f.body.submission.version = '2026-09-10.submission2';
    f.body.submission.status = 'needs_review';
    final.commandTransport = 'legacy-runner-migration';
    delete final.traceExport.exportKind;
    final.traceExport.path = '/fixture/final.traces-1789008365979/projects';
    final.traceExport.manifestPath =
      '/fixture/final.traces-1789008365979/manifest.json';
    return f;
  };
  const f = legacy();
  const before = structuredClone(f.initial.task);
  assert.equal((await f.call()).status, 200);
  assert.equal(f.saves(), 1);
  const saved = f.state().task;
  assert.deepEqual(saved.turns[0].automation.submission, f.body.submission);
  assert.equal(
    saved.turns[0].automation.submission.finalization.traceExport.exportKind,
    undefined,
  );
  assert.ok(submissionIssues(saved, saved.turns[0]).length > 0);
  delete saved.turns[0].automation.submission;
  assert.deepEqual(saved, before);
  for (const change of [
    (s) => {
      s.status = 'passed';
    },
    (s) => {
      s.status = 'awaiting_finalization';
    },
    (s) => {
      s.status = 'blocked';
    },
    (s) => {
      s.finalization.commandTransport = 'original-mac-terminal';
    },
    (s) => {
      s.finalization.taskId = 'other-task';
    },
    (s) => {
      s.finalization.questionId = 'other-question';
    },
    (s) => {
      s.finalization.containerId = digest('9');
    },
    (s) => {
      s.finalization.runId = 'other-run';
    },
    (s) => {
      s.finalization.sessionId = 'other-session';
    },
    (s) => {
      delete s.finalization.sessionId;
    },
    (s) => {
      s.finalization.traceExport.exportKind = 'intermediate';
    },
    (s) => {
      s.finalization.traceExport.exportKind = null;
    },
    (s) => {
      s.finalization.traceExport.path = '/fixture/turn.traces-123/projects';
    },
    (s) => {
      s.finalization.traceExport.manifestPath = '/other/manifest.json';
    },
  ]) {
    const rejected = legacy();
    change(rejected.body.submission);
    assert.equal((await rejected.call()).status, 400);
    assert.equal(rejected.saves(), 0);
  }
});

test('oversized, invalid time, digest, path and deeply nested metadata is rejected without writes', async () => {
  for (const change of [
    (s) => {
      s.reason = 'x'.repeat(65000);
    },
    (s) => {
      s.verifiedAt = 'invalid';
    },
    (s) => {
      s.manifestSha256 = 'invalid';
    },
    (s) => {
      s.manifestPath = '/' + 'x'.repeat(4000);
    },
    (s) => {
      s.zipArchivePath = 12;
    },
    (s) => {
      s.finalization.receiptPath += '\n';
    },
    (s) => {
      s.files = -1;
    },
    (s) => {
      s.nested = Array.from({ length: 20 }).reduce((v) => ({ nested: v }), {});
    },
  ]) {
    const f = fixture();
    change(f.body.submission);
    assert.equal((await f.call()).status, 400);
    assert.equal(f.saves(), 0);
  }
});

test('revision conflict is surfaced without overwriting a concurrent task change', async () => {
  const f = fixture();
  f.store.save = async () => {
    throw Error('数据已更新，请刷新后重试');
  };
  const result = await f.call();
  assert.equal(result.status, 400);
  assert.match(result.body.error, /数据已更新/);
  assert.deepEqual(f.state(), f.initial);
});
