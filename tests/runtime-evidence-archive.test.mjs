import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEvidenceArchive } from '../scripts/evidence.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(t, { probe = true, diagnosis = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'runtime-evidence-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'workspace');
  mkdirSync(workDir);
  const put = (name, bytes) => {
    const file = path.join(dir, name);
    writeFileSync(file, bytes);
    return file;
  };
  const raw = Buffer.from('进度 10%\r进度 100%\r\n\x1b[32m通过\x1b[0m\n');
  const numbered = Buffer.from(
    raw
      .toString('utf8')
      .split('\n')
      .map((text, i) => JSON.stringify({ line: i + 1, text }))
      .join('\n') + '\n',
  );
  const check = {
    id: 'browser-flow',
    logPath: put('browser-flow.log', raw),
    logSha256: hash(raw),
  };
  const runtime = {
    checks: [check],
    executionPath: put('execution.json', '{}'),
    plan: { tracePath: put('plan.jsonl', '{"type":"result"}\n') },
    diagnosis: { tracePath: put('diagnosis.jsonl', '{"type":"result"}\n') },
  };
  const probeBytes = Buffer.from('{"commands":{"bash":true}}\n');
  if (probe)
    runtime.environmentProbe = {
      version: '2026-09-10.env1',
      logPath: put('environment-probe.log', probeBytes),
      logSha256: hash(probeBytes),
    };
  if (diagnosis)
    runtime.diagnosisEvidence = {
      version: '2026-09-10.lf1',
      logs: [
        {
          ...check,
          lineCount: raw.toString('utf8').split('\n').length,
          numberedPath: put('browser-flow.lines.jsonl', numbered),
          numberedSha256: hash(numbered),
        },
      ],
    };
  const report = Buffer.from(JSON.stringify(runtime));
  runtime.reportPath = put('report.json', report);
  runtime.reportSha256 = hash(report);
  const args = {
    dir,
    turnId: 'turn',
    bundlePath: put('evaluation.json', '{}'),
    tracePath: put('claude.jsonl', '{"type":"user"}\n'),
    automation: { runtimeVerification: runtime },
    workDir,
  };
  const archive = () => createEvidenceArchive(args);
  return { dir, runtime, raw, numbered, probeBytes, archive };
}

test('runtime archive preserves and hashes probe, raw log, and LF view bytes', (t) => {
  const f = fixture(t);
  const archive = f.archive();
  const extract = (name) =>
    execFileSync('tar', ['-xOzf', archive.archivePath, name]);
  const manifest = JSON.parse(extract('manifest.json'));
  for (const [name, expected] of [
    ['runtime/environment-probe.log', f.probeBytes],
    ['runtime/browser-flow.log', f.raw],
    ['runtime/diagnosis-evidence/browser-flow.lines.jsonl', f.numbered],
  ]) {
    assert.deepEqual(extract(name), expected);
    const entry = manifest.files.find((file) => file.name === name);
    assert.equal(entry.sha256, hash(expected));
    assert.equal(entry.bytes, expected.length);
  }
  assert.deepEqual(readFileSync(f.runtime.checks[0].logPath), f.raw);
  assert.deepEqual(
    readFileSync(f.runtime.diagnosisEvidence.logs[0].numberedPath),
    f.numbered,
  );
  assert.deepEqual(
    readFileSync(f.runtime.environmentProbe.logPath),
    f.probeBytes,
  );
});

for (const [label, options] of [
  ['legacy reports', { probe: false, diagnosis: false }],
  ['only an environment probe', { probe: true, diagnosis: false }],
  ['only LF diagnosis views', { probe: false, diagnosis: true }],
]) {
  test('runtime archive supports ' + label, (t) => {
    const f = fixture(t, options);
    const archive = f.archive();
    const names = execFileSync('tar', ['-tzf', archive.archivePath], {
      encoding: 'utf8',
    }).split('\n');
    assert.equal(
      names.includes('runtime/environment-probe.log'),
      options.probe,
    );
    assert.equal(
      names.includes('runtime/diagnosis-evidence/browser-flow.lines.jsonl'),
      options.diagnosis,
    );
  });
}

for (const field of ['probe', 'view']) {
  test('runtime archive rejects changed ' + field + ' evidence', (t) => {
    const f = fixture(t);
    const file =
      field === 'probe'
        ? f.runtime.environmentProbe.logPath
        : f.runtime.diagnosisEvidence.logs[0].numberedPath;
    writeFileSync(file, 'modified after verification\n');
    assert.throws(f.archive, /交付证据摘要不一致/);
  });
  test('runtime archive rejects missing hash for ' + field, (t) => {
    const f = fixture(t);
    if (field === 'probe') delete f.runtime.environmentProbe.logSha256;
    else delete f.runtime.diagnosisEvidence.logs[0].numberedSha256;
    assert.throws(f.archive, /独立验收附加证据无效/);
  });
}

test('runtime archive rejects a view bound to a different original log', (t) => {
  const f = fixture(t);
  f.runtime.diagnosisEvidence.logs[0].logSha256 = 'a'.repeat(64);
  assert.throws(f.archive, /诊断行号证据与原始验收日志不符/);
});

test('runtime archive rejects missing diagnosis views', (t) => {
  const f = fixture(t);
  f.runtime.diagnosisEvidence.logs = [];
  assert.throws(f.archive, /诊断行号证据与验收日志数量不符/);
});
