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

for (const premarkedDone of [false, true])
  test(`replanning preserves the scored submission after ${premarkedDone ? 'an old false completion' : 'a lost acknowledgement'}`, async (t) => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), 'replan-submission-')),
    );
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const taskId = randomUUID(),
      questionId = randomUUID();
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
    f.state.results = { [questionId]: { success: true } };
    queueFinalSubmission(root, f.state);
    const resultPath = path.join(dir, questionId + '.result.json');
    const original = JSON.stringify({
      taskId,
      turnId: questionId,
      success: true,
      container: { containerId: f.state.containerId },
      review: { source: 'codex', scores: [3, 4, 3, 4, 3] },
      automation: { archive: { sha256: 'e'.repeat(64) } },
    });
    writeFileSync(resultPath, original);
    let calls = 0,
      builds = 0;
    const options = {
      workRoot: root,
      createPackage: ({ archive, finalization }) => {
        builds++;
        return {
          status: 'passed',
          sourceArchiveSha256: archive.sha256,
          finalization,
        };
      },
      verifyPackage: () => {},
      api: async () => {
        if (++calls === 1) throw Error('lost acknowledgement');
      },
    };
    await flushFinalSubmissions(options);
    assert.equal(calls, 1);
    const queue = path.join(
      root,
      'final-submissions',
      taskId + '.' + questionId + '.json',
    );
    const requestPath = path.join(dir, questionId + '.final-submission.json');
    const request = readFileSync(requestPath, 'utf8');
    const replan = JSON.stringify({
      taskId,
      turnId: questionId,
      success: true,
      projectRecovery: { state: 'planned' },
    });
    writeFileSync(
      path.join(dir, questionId + '.pre-replan-result.json'),
      original,
    );
    writeFileSync(resultPath, replan);
    rmSync(queue + '.retry');
    if (premarkedDone) writeFileSync(queue + '.done', 'historical completion');
    await flushFinalSubmissions({ ...options, queueNames: ['unrelated.json'] });
    assert.equal(calls, 1);
    await flushFinalSubmissions(options);
    assert.equal(calls, 2);
    assert.equal(builds, 1, 'reuse the existing immutable submission request');
    assert(existsSync(requestPath + '.delivered'));
    await flushFinalSubmissions(options);
    assert.equal(calls, 2, 'acknowledged submission is not sent again');
    assert.equal(readFileSync(resultPath, 'utf8'), replan);
    assert.equal(
      readFileSync(
        path.join(dir, questionId + '.pre-replan-result.json'),
        'utf8',
      ),
      original,
    );
    assert.equal(readFileSync(requestPath, 'utf8'), request);
    if (premarkedDone)
      assert.equal(
        readFileSync(queue + '.done', 'utf8'),
        'historical completion',
      );

    // Reopened completion must still validate the saved evaluation's identity.
    rmSync(requestPath + '.delivered');
    writeFileSync(
      path.join(dir, questionId + '.pre-replan-result.json'),
      JSON.stringify({ ...JSON.parse(original), taskId: randomUUID() }),
    );
    const errors = [];
    await flushFinalSubmissions({
      ...options,
      onError: (e) => errors.push(e.reason),
    });
    assert.equal(calls, 2);
    assert.match(errors.join(), /身份不符/);
  });
