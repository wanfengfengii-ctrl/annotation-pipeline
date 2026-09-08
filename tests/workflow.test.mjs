import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nextDecision, dailyMix } from '../lib/workflow.mjs';
import {
  verifyScoreEvidence,
  createEvidenceArchive,
  reviewEvidence,
} from '../scripts/evidence.mjs';
import { acquireLock, identity, livingChildren } from '../scripts/recovery.mjs';
test('automatic continuation honors pause, ten rounds, repeated goals and input decisions', () => {
  const turn = {
    prompt: 'first',
    automation: {
      next: {
        value: { action: 'repair', prompt: 'fix', reason: 'failed assertion' },
      },
    },
  };
  assert.equal(
    nextDecision({ turns: [turn] }, turn, { autoContinue: false }),
    null,
  );
  assert.equal(
    nextDecision({ turns: [turn] }, turn, { autoContinue: true }).prompt,
    'fix',
  );
  assert.equal(
    nextDecision({ turns: Array(10).fill(turn) }, turn, { autoContinue: true })
      .prompt,
    undefined,
  );
  assert.equal(
    nextDecision(
      { turns: [{ prompt: 'fix' }, { requestedPrompt: 'fix' }] },
      turn,
      { autoContinue: true },
    ).prompt,
    undefined,
  );
  turn.automation.next.value.action = 'needs_input';
  assert.equal(
    nextDecision({ turns: [turn] }, turn, { autoContinue: true }).prompt,
    undefined,
  );
});
test('daily mix counts actual completed local date and reserved work', () => {
  const mix = dailyMix(
    [
      {
        turns: [
          {
            category: '0-1 代码生成',
            status: 'review',
            finishedAt: '2026-09-06T17:00:00Z',
          },
          {
            category: 'Feature 迭代',
            status: 'queued',
            createdAt: '2026-09-05T00:00:00Z',
          },
        ],
      },
    ],
    '2026-09-07',
  );
  assert.equal(mix.counts['0-1 代码生成'], 1);
  assert.equal(mix.reserved['Feature 迭代'], 1);
  assert.equal(mix.suggested, 'Bug 修复');
});
test('evidence verifies locations and archive hashes, includes new code and lists excluded secrets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ],
      { cwd: dir },
    );
    writeFileSync(path.join(dir, 'new.js'), 'export const answer=42;\n');
    writeFileSync(path.join(dir, '.env'), 'FAKE_ONLY=excluded');
    const trace = path.join(dir, 'trace.jsonl');
    writeFileSync(trace, '{"type":"result"}\n');
    const value = Object.fromEntries(
      ['when', 'behavior', 'impact', 'expected', 'descriptions'].map((k) => [
        k,
        Array(5).fill(k),
      ]),
    );
    value.evidenceRefs = Array(5).fill(trace + ':1');
    value.descriptions = Array(5).fill(
      '已经生成基础代码。测试没有运行，运行结果未验证。',
    );
    const verified = verifyScoreEvidence(value, dir, dir);
    assert.deepEqual(verified.descriptions, value.descriptions);
    assert.deepEqual(verified.when, value.when);
    assert.deepEqual(
      verifyScoreEvidence(verified, dir, dir).descriptions,
      verified.descriptions,
    );
    assert.throws(() =>
      verifyScoreEvidence(
        { ...value, evidenceRefs: Array(5).fill(trace + ':100') },
        dir,
        dir,
      ),
    );
    assert.throws(() =>
      verifyScoreEvidence(
        { ...value, evidenceRefs: Array(5).fill('/etc/hosts:1') },
        dir,
        dir,
      ),
    );
    const bundle = path.join(dir, 'bundle.json');
    writeFileSync(bundle, '{}');
    const archive = createEvidenceArchive({
      dir,
      turnId: 'turn',
      bundlePath: bundle,
      tracePath: trace,
      automation: { score: { value: verified } },
      workDir: dir,
    });
    const preview = reviewEvidence({ dir, turnId: 'turn', tracePath: trace });
    assert.equal(
      preview.find((e) => e.id === 'trace').content,
      readFileSync(trace, 'utf8'),
    );
    assert.equal(preview.find((e) => e.id === 'trace').truncated, false);
    writeFileSync(trace, 'changed by later round');
    const frozen = reviewEvidence({ dir, turnId: 'turn', tracePath: trace });
    assert.match(
      frozen.find((e) => e.originalRef === trace + ':1').content,
      /type.*result/,
    );
    assert.ok(
      !frozen
        .find((e) => e.originalRef === trace + ':1')
        .content.includes('changed by later'),
    );
    assert.ok(frozen.find((e) => e.originalRef).sha256);
    assert.equal(
      archive.sha256,
      createHash('sha256')
        .update(readFileSync(archive.archivePath))
        .digest('hex'),
    );
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', archive.archivePath, 'manifest.json'], {
        encoding: 'utf8',
      }),
    );
    assert.ok(manifest.files.some((f) => f.name === 'untracked/new.js'));
    assert.ok(manifest.omitted.some((f) => f.name === '.env'));
    assert.ok(!manifest.files.some((f) => f.name === 'untracked/.env'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('runner lock rejects living owner and replaces verified dead owner; orphan identity checked', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recovery-')),
    lock = path.join(dir, 'lock');
  try {
    acquireLock(lock);
    assert.throws(() => acquireLock(lock));
    writeFileSync(lock, '2147483647');
    acquireLock(lock);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
    assert.equal(
      livingChildren({
        children: [{ pid: process.pid, identity: identity(process.pid) }],
      }).length,
      1,
    );
    assert.equal(
      livingChildren({
        children: [{ pid: process.pid, identity: 'old-process' }],
      }).length,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
