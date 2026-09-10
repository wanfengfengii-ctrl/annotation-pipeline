import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submissionIssues,
  submissionPolicyVersion,
} from '../lib/submission-policy.mjs';
import { recordRow } from '../lib/record-fields.ts';
import { csv, issues } from '../lib/pipeline.ts';
import { canRepair } from '../lib/project-series.mjs';
import { permissionAuditVersion } from '../lib/permission-audit.mjs';

function fixture() {
  const traceExport = {
    verified: true,
    sha256: 'a'.repeat(64),
    exportKind: 'intermediate',
  };
  const finalization = {
    version: '2026-09-10.terminal-finalization1',
    taskId: 'task',
    questionId: 'question',
    containerId: 'c'.repeat(64),
    runId: 'run',
    sessionId: 'session',
    status: 'removed',
    commandTransport: 'original-mac-terminal',
    traceExport: {
      verified: true,
      exportKind: 'final',
      commandTransport: 'original-mac-terminal',
      files: 3,
      sha256: 'b'.repeat(64),
      path: '/fixture/final/projects',
    },
    manifestSha256: 'd'.repeat(64),
    receiptSha256: 'e'.repeat(64),
    receiptPath: '/fixture/questions/question/terminal/finalization.json',
    removedAt: '2026-09-10T00:00:00.000Z',
  };
  const turn = {
    id: 'question',
    questionRootId: 'question',
    prompt: 'Unique fixture prompt',
    sessionId: 'session',
    promptId: 'native-prompt',
    status: 'review',
    category: '0-1 代码生成',
    difficulty: '困难',
    tracePath: '/fixture/trace.jsonl',
    traceExport,
    createdAt: '2026-09-09T00:00:00.000Z',
    finishedAt: '2026-09-09T01:00:00.000Z',
    container: {
      taskId: 'task',
      questionId: 'question',
      containerId: finalization.containerId,
      status: 'running',
      terminalIdentity: {
        transport: 'mac-terminal',
        realTerminal: true,
        tty: '/dev/ttys001',
        runId: 'run',
      },
    },
    permissionAudit: {
      version: permissionAuditVersion,
      passed: true,
      modeVerified: true,
      denialCount: 0,
      traceSha256: traceExport.sha256,
    },
    review: {
      source: 'codex',
      reviewer: 'fixture',
      scores: Array(5).fill(4),
      descriptions: Array(5).fill('fixture evidence'),
    },
    humanReview: {
      state: 'approved',
      draft: {
        reviewer: 'fixture-human',
        verification: 'Observed fixture',
        process: 'Checked',
        artifact: 'Checked',
        attested: true,
        findings: Array.from({ length: 5 }, () => ({
          score: 4,
          when: 'fixture',
          behavior: 'observed',
          impact: 'fixture',
          expected: 'fixture',
          evidenceRefs: 'prompt:1',
        })),
      },
    },
    automation: {
      delivery: { value: { passed: true } },
      bundlePath: '/fixture/bundle.json',
      archive: { sha256: 'f'.repeat(64) },
      submission: {
        version: submissionPolicyVersion,
        status: 'passed',
        finalization,
        traceExportSha256: finalization.traceExport.sha256,
        sourceArchiveSha256: 'f'.repeat(64),
        reviewRequiredFiles: [],
      },
    },
  };
  const snapshot =
    'https://github.com/fixture/initial/commit/' + '1'.repeat(40);
  const task = {
    id: 'task',
    title: 'fixture',
    turns: [turn],
    snapshot,
    harnessVersion: '2.1',
    os: 'macOS',
    initialCodeSnapshots: { question: { url: snapshot } },
  };
  return { task, turn, finalization, submission: turn.automation.submission };
}

test('external gating preserves ordinary imported records without a pipeline container', () => {
  const { task, turn } = fixture();
  delete turn.container;
  delete turn.automation.submission;
  // A project's later container cannot retroactively convert an imported turn.
  task.container = { status: 'running', questionId: 'unrelated' };
  assert.deepEqual(submissionIssues(task, turn), []);
  assert.equal(recordRow(task, turn, 'ai').eligible, true);
  assert.match(csv([task]), /Unique fixture prompt/);
});

test('internal content warnings do not block native delivery but cannot bypass finalization', () => {
  const f = fixture();
  f.submission.status = 'needs_review';
  f.submission.contentScanStatus = 'needs_review';
  f.submission.reviewRequiredFiles = [
    {
      name: 'evaluation.json',
      reason: 'unsupported-binary-encoding-or-structure',
    },
    { name: 'workspace/fixture.sqlite3', reason: 'sensitive-sqlite-content' },
  ];
  assert.deepEqual(submissionIssues(f.task, f.turn), []);
  assert.equal(recordRow(f.task, f.turn, 'ai').eligible, true);
  f.finalization.sessionId = 'another-session';
  assert.ok(submissionIssues(f.task, f.turn).length);
  f.finalization.sessionId = f.turn.sessionId;
  f.submission.reviewRequiredFiles.push({
    name: 'trace',
    reason: 'missing-source',
  });
  assert.ok(submissionIssues(f.task, f.turn).length);
});

test('all container records need submission2 final completion, including old packages and human exports', () => {
  for (const change of [
    (f) => {
      delete f.turn.automation.submission;
    },
    (f) => {
      f.submission.version = '2026-09-10.submission1';
    },
    (f) => {
      f.submission.status = 'awaiting_finalization';
    },
    (f) => {
      f.submission.status = 'needs_review';
    },
    (f) => {
      f.submission.reviewRequiredFiles.push({ name: 'unchecked' });
    },
    (f) => {
      delete f.submission.finalization;
    },
  ]) {
    const f = fixture();
    change(f);
    const before = JSON.stringify(f.task);
    assert.ok(submissionIssues(f.task, f.turn).length);
    for (const source of ['ai', 'human'])
      assert.equal(recordRow(f.task, f.turn, source).eligible, false);
    for (const source of ['primary', 'human'])
      assert.ok(!csv([f.task], source).includes(f.turn.prompt));
    // Internal review and in-session repair remain available while export waits.
    assert.deepEqual(issues(f.task, f.turn), []);
    assert.equal(canRepair(f.task, f.turn), true);
    assert.equal(JSON.stringify(f.task), before);
  }
});

test('finalization is bound to this task, question, container, terminal and session', () => {
  for (const key of [
    'taskId',
    'questionId',
    'containerId',
    'runId',
    'sessionId',
  ]) {
    const f = fixture();
    f.finalization[key] = 'different';
    assert.ok(submissionIssues(f.task, f.turn).length, key);
  }
  for (const change of [
    (f) => {
      f.turn.container.questionId = 'different';
    },
    (f) => {
      f.turn.container.taskId = 'different';
    },
    (f) => {
      f.turn.container.terminal = { runId: 'different' };
    },
    (f) => {
      delete f.turn.container.terminalIdentity.runId;
    },
    (f) => {
      delete f.turn.sessionId;
    },
    (f) => {
      delete f.turn.questionRootId;
      f.turn.repairOf = 'missing';
    },
  ]) {
    const f = fixture();
    change(f);
    assert.ok(submissionIssues(f.task, f.turn).length);
  }
});

test('legacy transport, intermediate export, unfinished removal and mismatched evidence never qualify', () => {
  for (const change of [
    (f) => {
      f.finalization.version = 'unknown';
    },
    (f) => {
      f.finalization.commandTransport = 'legacy-runner-migration';
    },
    (f) => {
      f.finalization.status = 'exported';
    },
    (f) => {
      f.finalization.removedAt = 'invalid';
    },
    (f) => {
      f.finalization.traceExport.exportKind = 'intermediate';
    },
    (f) => {
      f.finalization.traceExport.commandTransport = 'runner-read-only-snapshot';
    },
    (f) => {
      f.finalization.traceExport.verified = false;
    },
    (f) => {
      f.finalization.traceExport.files = 0;
    },
    (f) => {
      f.finalization.traceExport.sha256 = '0'.repeat(64);
    },
    (f) => {
      f.finalization.manifestSha256 = '';
    },
    (f) => {
      f.finalization.receiptSha256 = '';
    },
    (f) => {
      f.finalization.receiptPath = '';
    },
    (f) => {
      f.submission.sourceArchiveSha256 = '0'.repeat(64);
    },
    (f) => {
      delete f.turn.automation.archive;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.ok(submissionIssues(f.task, f.turn).length);
  }
});

test('three original rounds can share final trace after rotation without changing source evidence', () => {
  const f = fixture(),
    root = f.turn;
  f.task.container = { questionId: 'next-question', status: 'running' };
  for (const [index, id] of ['repair-one', 'repair-two'].entries()) {
    const turn = structuredClone(root);
    turn.id = id;
    turn.repairOf = f.task.turns.at(-1).id;
    turn.category = 'Bug 修复';
    turn.promptId = 'native-prompt-' + index;
    turn.automation.archive.sha256 = String(index + 2).repeat(64);
    turn.automation.submission.sourceArchiveSha256 =
      turn.automation.archive.sha256;
    f.task.turns.push(turn);
  }
  const before = JSON.stringify(f.task);
  for (const turn of f.task.turns) {
    assert.deepEqual(submissionIssues(f.task, turn), []);
    for (const source of ['ai', 'human'])
      assert.equal(recordRow(f.task, turn, source).eligible, true);
    assert.equal(turn.traceExport.exportKind, 'intermediate');
  }
  for (const source of ['primary', 'human'])
    assert.equal(csv([f.task], source).split('\r\n').length, 4);
  assert.equal(JSON.stringify(f.task), before);
  // Legacy continuation records still derive their root through repairOf.
  delete f.task.turns[1].questionRootId;
  delete f.task.turns[2].questionRootId;
  for (const turn of f.task.turns)
    assert.deepEqual(submissionIssues(f.task, turn), []);
});

test('a saved batch must recheck current submission metadata instead of its prior eligible flag', () => {
  const f = fixture(),
    saved = recordRow(f.task, f.turn, 'ai'),
    before = JSON.stringify(f.task);
  assert.equal(saved.eligible, true);
  assert.deepEqual(submissionIssues(f.task, f.turn), []);
  f.finalization.commandTransport = 'legacy-runner-migration';
  assert.ok(submissionIssues(f.task, f.turn).length);
  assert.equal(saved.eligible, true);
  f.finalization.commandTransport = 'original-mac-terminal';
  assert.equal(JSON.stringify(f.task), before);
});
