import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { finalizationFixture } from './fixtures/finalization.mjs';
import {
  queueFinalSubmission,
  queueRecoveredFinalSubmission,
  flushFinalSubmissions,
} from '../scripts/final-submissions.mjs';

test('a late recovered score gets its own queue after the original finalization was already completed', async (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'recovered-submission-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskId = randomUUID(),
    questionId = randomUUID(),
    turnId = questionId;
  const dir = path.join(root, taskId),
    terminalDir = path.join(dir, 'questions', questionId, 'terminal');
  mkdirSync(terminalDir, { recursive: true });
  const terminal = {
    runId: randomUUID(),
    statePath: path.join(terminalDir, 'state.json'),
    launchPath: path.join(terminalDir, 'question.command'),
  };
  writeFileSync(
    path.join(terminalDir, 'launch.json'),
    JSON.stringify(terminal),
  );
  const f = finalizationFixture(dir, terminal, questionId);
  f.state.results = { [turnId]: { success: true } };
  const receipt = path.join(dir, turnId + '.result.json');
  writeFileSync(receipt, JSON.stringify({ success: false, taskId, turnId }));
  queueFinalSubmission(root, f.state);
  const calls = [];
  const options = {
    workRoot: root,
    api: async (r) => calls.push(r),
    createPackage: ({ archive, finalization }) => ({
      status: 'passed',
      sourceArchiveSha256: archive.sha256,
      finalization,
    }),
    verifyPackage: () => {},
  };
  await flushFinalSubmissions(options);
  assert.equal(calls.length, 0);
  const done = path.join(
    root,
    'final-submissions',
    taskId + '.' + questionId + '.json.done',
  );
  const originalDone = readFileSync(done, 'utf8');
  const result = {
    success: true,
    taskId,
    turnId,
    container: { containerId: f.state.containerId },
    review: { source: 'codex', scores: [3, 3, 3, 3, 3] },
    automation: { archive: { sha256: 'c'.repeat(64) } },
  };
  writeFileSync(receipt, JSON.stringify(result));
  queueRecoveredFinalSubmission(
    root,
    f.state,
    turnId,
    result.automation.archive.sha256,
  );
  queueRecoveredFinalSubmission(
    root,
    f.state,
    turnId,
    result.automation.archive.sha256,
  );
  await flushFinalSubmissions(options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turnId, turnId);
  assert.equal(
    calls[0].submission.finalization.containerId,
    f.state.containerId,
  );
  assert.equal(readFileSync(done, 'utf8'), originalDone);
  assert.deepEqual(JSON.parse(readFileSync(receipt)), result);
  assert.throws(() =>
    queueRecoveredFinalSubmission(
      root,
      { ...f.state, status: 'running' },
      turnId,
      'c'.repeat(64),
    ),
  );
});

test('final submission queue survives container replacement, retries only delivery and preserves original results', async (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'final-submission-queue-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskId = randomUUID(),
    questionId = randomUUID(),
    turnIds = [questionId, randomUUID(), randomUUID()];
  const dir = path.join(root, taskId),
    terminalDir = path.join(dir, 'questions', questionId, 'terminal');
  mkdirSync(terminalDir, { recursive: true });
  const terminal = {
    runId: randomUUID(),
    statePath: path.join(terminalDir, 'state.json'),
    launchPath: path.join(terminalDir, 'question.command'),
  };
  writeFileSync(
    path.join(terminalDir, 'launch.json'),
    JSON.stringify(terminal),
  );
  const f = finalizationFixture(dir, terminal, questionId);
  f.state.results = Object.fromEntries(turnIds.map((id) => [id, {}]));
  const originals = turnIds.map((turnId) => {
    const file = path.join(dir, turnId + '.result.json');
    const result = {
      taskId,
      turnId,
      container: { containerId: f.state.containerId },
      review: { scores: [3, 3, 3, 3, 3], source: 'codex' },
      automation: { archive: { sha256: 'b'.repeat(64) } },
    };
    const bytes = JSON.stringify(result);
    writeFileSync(file, bytes);
    return [file, bytes];
  });
  queueFinalSubmission(root, f.state);
  queueFinalSubmission(root, f.state);
  assert.equal(readdirSync(path.join(root, 'final-submissions')).length, 1);
  let builds = 0,
    checks = 0,
    sends = 0;
  const received = [];
  const options = {
    workRoot: root,
    createPackage: ({ finalization, archive, turnId }) => {
      builds++;
      return {
        status: 'passed',
        finalization,
        sourceArchiveSha256: archive.sha256,
        manifestSha256: turnId,
      };
    },
    verifyPackage: () => {
      checks++;
    },
    api: async (request) => {
      sends++;
      if (sends === 1) throw Error('lost acknowledgement');
      received.push(request);
    },
  };
  await flushFinalSubmissions(options);
  assert.equal(builds, 1);
  const queue = path.join(
    root,
    'final-submissions',
    taskId + '.' + questionId + '.json',
  );
  assert(!existsSync(queue + '.done'));
  rmSync(queue + '.retry');
  await flushFinalSubmissions(options);
  assert.equal(
    builds,
    3,
    'first immutable package is reused after lost API response',
  );
  assert.equal(checks, 4);
  assert.deepEqual(
    received.map((r) => r.turnId),
    turnIds,
  );
  assert(existsSync(queue + '.done'));
  await flushFinalSubmissions(options);
  assert.equal(sends, 4);
  for (const [file, bytes] of originals)
    assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('missing finalization cannot publish, and failure stays in the queue independently of scoring', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'missing-final-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskId = randomUUID(),
    questionId = randomUUID();
  queueFinalSubmission(root, {
    taskId,
    questionId,
    status: 'removed',
    results: {},
  });
  let errors = 0;
  await flushFinalSubmissions({
    workRoot: root,
    api: () => assert.fail('must not publish'),
    onError: () => errors++,
  });
  assert.equal(errors, 1);
  assert(
    !readdirSync(path.join(root, 'final-submissions')).some((name) =>
      name.endsWith('.done'),
    ),
  );
});
