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

function addBrowserCache(t, f) {
  const sharedRoot = mkdtempSync(path.join(tmpdir(), 'runtime-tool-cache-'));
  t.after(() => rmSync(sharedRoot, { recursive: true, force: true }));
  writeFileSync(path.join(sharedRoot, 'headless_shell'), 'browser binary');
  const files = [
    {
      field: 'record',
      name: 'usage.json',
      bytes: Buffer.from(
        JSON.stringify({ source: sharedRoot, readOnly: true }),
      ),
    },
    {
      field: 'manifest',
      name: 'ready.json',
      bytes: Buffer.from(
        JSON.stringify({
          smoke: {
            passed: true,
            toolVersion: '1.55.0',
            browserVersion: 'fixture',
          },
          files: [{ path: 'headless_shell', sha256: hash('browser binary') }],
        }),
      ),
    },
    {
      field: 'buildLog',
      name: 'build.log',
      bytes: Buffer.from(
        'download 10%\rdownload 100%\nBROWSER_CACHE_SMOKE_PASSED\n',
      ),
    },
  ];
  const cache = { toolVersion: '1.55.0', platform: 'linux/arm64' };
  for (const file of files) {
    file.path = path.join(f.dir, 'browser-cache.' + file.name);
    writeFileSync(file.path, file.bytes);
    cache[file.field + 'Path'] = file.path;
    cache[file.field + 'Sha256'] = hash(file.bytes);
  }
  f.runtime.environmentProbe.browserCache = cache;
  // The report describes the exact task-local snapshots used by the archive.
  const report = JSON.stringify(f.runtime);
  writeFileSync(f.runtime.reportPath, report);
  f.runtime.reportSha256 = hash(report);
  return { cache, files, sharedRoot };
}

test('runtime archive freezes browser cache usage, ready proof and build log without binaries', (t) => {
  const f = fixture(t),
    browser = addBrowserCache(t, f);
  const archive = f.archive();
  const extract = (name) =>
    execFileSync('tar', ['-xOzf', archive.archivePath, name]);
  const manifest = JSON.parse(extract('manifest.json'));
  const entries = manifest.files.filter((file) =>
    file.name.startsWith('runtime/browser-cache/'),
  );
  assert.equal(entries.length, 3);
  assert(!manifest.files.some((file) => file.name.includes('headless_shell')));
  for (const file of browser.files) {
    const name = 'runtime/browser-cache/' + file.name;
    assert.deepEqual(extract(name), file.bytes);
    assert.equal(
      entries.find((entry) => entry.name === name).sha256,
      hash(file.bytes),
    );
    assert.deepEqual(readFileSync(file.path), file.bytes);
  }
  assert.equal(
    JSON.parse(extract('runtime/browser-cache/ready.json')).smoke.passed,
    true,
  );
});

for (const field of ['record', 'manifest', 'buildLog']) {
  test('runtime archive rejects changed browser cache ' + field, (t) => {
    const f = fixture(t),
      { cache } = addBrowserCache(t, f);
    writeFileSync(cache[field + 'Path'], 'modified cache evidence');
    assert.throws(f.archive, /交付证据摘要不一致/);
  });
}

test('runtime archive does not accept shared cache paths instead of task-local snapshots', (t) => {
  const f = fixture(t),
    { cache, files, sharedRoot } = addBrowserCache(t, f);
  cache.manifestPath = path.join(sharedRoot, 'ready.json');
  writeFileSync(
    cache.manifestPath,
    files.find((file) => file.field === 'manifest').bytes,
  );
  assert.throws(f.archive, /独立验收附加证据无效/);
});

test('runtime archive rejects browser cache use without build evidence', (t) => {
  const f = fixture(t),
    { cache } = addBrowserCache(t, f);
  delete cache.buildLogSha256;
  assert.throws(f.archive, /独立验收附加证据无效/);
});

function addRegressionHistory(f) {
  const previousDir = path.join(f.dir, 'previous-turn.runtime');
  mkdirSync(previousDir);
  const logs = [
    {
      id: 'geometry',
      bytes: Buffer.from('measure 10%\rmeasure 100%\r\nFAIL ratio\n'),
    },
    {
      id: 'slot-swap',
      bytes: Buffer.from('\x1b[31mFAIL\x1b[0m target page lost\n'),
    },
  ];
  for (const log of logs) {
    log.path = path.join(previousDir, log.id + '.log');
    writeFileSync(log.path, log.bytes);
  }
  const report = {
    path: path.join(previousDir, 'report.json'),
    bytes: Buffer.from(
      JSON.stringify({
        status: 'bugs',
        checks: logs.map((log) => ({
          id: log.id,
          outcome: 'reproduced',
          logPath: log.path,
          logSha256: hash(log.bytes),
        })),
      }),
    ),
  };
  writeFileSync(report.path, report.bytes);
  f.runtime.regressionContext = {
    version: 'fixture-regression-v1',
    checks: logs.map((log) => ({
      id: log.id,
      scope: 'inherited-regression',
      sourceTurnId: 'previous-turn',
      sourceReportPath: report.path,
      sourceReportSha256: hash(report.bytes),
      sourceLogPath: log.path,
      sourceLogSha256: hash(log.bytes),
    })),
  };
  const currentReport = Buffer.from(JSON.stringify(f.runtime));
  writeFileSync(f.runtime.reportPath, currentReport);
  f.runtime.reportSha256 = hash(currentReport);
  return { report, logs, checks: f.runtime.regressionContext.checks };
}

test('runtime archive freezes historical regression sources with hashes and deduplicates their report', (t) => {
  const f = fixture(t),
    history = addRegressionHistory(f);
  const archive = f.archive();
  const extract = (name) =>
    execFileSync('tar', ['-xOzf', archive.archivePath, name]);
  const manifest = JSON.parse(extract('manifest.json'));
  const entries = manifest.files.filter((file) =>
    file.name.startsWith('runtime/regression-history/'),
  );
  assert.equal(entries.length, 3);
  for (const [source, suffix] of [
    [history.report, '.report.json'],
    ...history.logs.map((log) => [log, '.log']),
  ]) {
    const digest = hash(source.bytes);
    const name = 'runtime/regression-history/' + digest + suffix;
    const matching = entries.filter((entry) => entry.name === name);
    assert.equal(matching.length, 1);
    assert.equal(matching[0].sha256, digest);
    assert.equal(matching[0].bytes, source.bytes.length);
    assert.deepEqual(extract(name), source.bytes);
    assert.deepEqual(readFileSync(source.path), source.bytes);
  }
  assert.deepEqual(
    JSON.parse(extract('runtime/report.json')).regressionContext.checks,
    history.checks,
  );
});

for (const field of ['sourceReport', 'sourceLog']) {
  test('runtime archive rejects changed regression ' + field, (t) => {
    const f = fixture(t),
      history = addRegressionHistory(f);
    writeFileSync(
      history.checks[0][field + 'Path'],
      'changed historical evidence\n',
    );
    assert.throws(f.archive, /交付证据摘要不一致/);
  });

  test(
    'runtime archive rejects regression ' + field + ' outside the task',
    (t) => {
      const f = fixture(t),
        history = addRegressionHistory(f);
      const outside = mkdtempSync(path.join(tmpdir(), 'regression-outside-'));
      t.after(() => rmSync(outside, { recursive: true, force: true }));
      const file = path.join(outside, 'evidence');
      writeFileSync(file, readFileSync(history.checks[0][field + 'Path']));
      history.checks[0][field + 'Path'] = file;
      assert.throws(f.archive, /独立验收附加证据无效/);
    },
  );

  test(
    'runtime archive rejects regression ' + field + ' without its hash',
    (t) => {
      const f = fixture(t),
        history = addRegressionHistory(f);
      delete history.checks[0][field + 'Sha256'];
      assert.throws(f.archive, /独立验收附加证据无效/);
    },
  );
}

for (const invalid of ['outside', 'changed']) {
  test(
    'runtime archive still validates a duplicate report reference when ' +
      invalid,
    (t) => {
      const f = fixture(t),
        history = addRegressionHistory(f);
      const copyDir =
        invalid === 'outside'
          ? mkdtempSync(path.join(tmpdir(), 'regression-duplicate-outside-'))
          : f.dir;
      if (invalid === 'outside')
        t.after(() => rmSync(copyDir, { recursive: true, force: true }));
      const copy = path.join(copyDir, 'duplicate-report.json');
      writeFileSync(
        copy,
        invalid === 'outside' ? history.report.bytes : 'changed duplicate',
      );
      // The SHA matches the first reference, but each source must still be checked.
      history.checks[1].sourceReportPath = copy;
      assert.throws(
        f.archive,
        invalid === 'outside' ? /独立验收附加证据无效/ : /交付证据摘要不一致/,
      );
    },
  );
}
