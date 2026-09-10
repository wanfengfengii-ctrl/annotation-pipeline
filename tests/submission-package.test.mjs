import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync, unzipSync } from 'fflate';
import {
  createEvidenceArchive,
  verifyNativeExport,
} from '../scripts/evidence.mjs';
import {
  createSubmissionPackage,
  verifySubmissionPackage,
} from '../scripts/submission-package.mjs';
import { sanitizeSensitiveText } from '../lib/sensitive-content.mjs';
import {
  writeTerminalFinalization,
  verifyTerminalFinalization,
} from '../scripts/terminal-finalization.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtureContainerId = 'a'.repeat(64);
function fixture(t, { binary = false, archiveNative = true } = {}) {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'submission-package-')),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workDir = path.join(dir, 'workspace');
  mkdirSync(workDir);
  const terminalDirectory = path.join(dir, 'questions/question/terminal');
  mkdirSync(terminalDirectory, { recursive: true });
  const terminal = {
    runId: 'fixture-terminal-run',
    statePath: path.join(terminalDirectory, 'state.json'),
    launchPath: path.join(terminalDirectory, 'question.command'),
  };
  const terminalState = {
    runId: terminal.runId,
    containerId: fixtureContainerId,
    status: 'exited',
    postprocessingComplete: true,
    verifiedExport: true,
    containerRemoved: true,
  };
  writeFileSync(terminal.statePath, JSON.stringify(terminalState));
  writeFileSync(terminal.launchPath, '# synthetic terminal launch\n');
  const secret = 'fixture-private-credential-9845';
  const provider = 'sk-' + 'a8'.repeat(18);
  writeFileSync(
    path.join(workDir, 'app.js'),
    `const key = "${provider}";\nconsole.log("result");\n`,
  );
  const nativeRoot = path.join(dir, 'export', 'projects');
  mkdirSync(path.join(nativeRoot, '-workspace/subagents/empty'), {
    recursive: true,
  });
  const contents = new Map([
    [
      '-workspace/main.jsonl',
      JSON.stringify({ message: { content: 'Expected result; ' + secret } }) +
        '\n' +
        JSON.stringify({ phone: 13800001234 }) +
        '\n',
    ],
    [
      '-workspace/subagents/agent.jsonl',
      JSON.stringify({
        contact: 'person@fixture-email.local',
        content: 'subagent evidence',
      }) + '\n',
    ],
    ['-workspace/notes.txt', 'ASSERT PASS\r\nOriginal evidence\n'],
  ]);
  if (binary)
    contents.set(
      '-workspace/image.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 7]),
    );
  const files = [];
  for (const [name, content] of contents) {
    const bytes = Buffer.from(content);
    writeFileSync(path.join(nativeRoot, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  const manifestPath = path.join(dir, 'export/manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ containerId: fixtureContainerId, files }),
  );
  const traceExport = {
    verified: true,
    path: nativeRoot,
    manifestPath,
    files: files.length,
    sha256: hash(JSON.stringify(files)),
  };
  const tracePath = path.join(dir, 'turn.jsonl');
  writeFileSync(tracePath, contents.get('-workspace/main.jsonl'));
  const bundlePath = path.join(dir, 'evaluation.json');
  writeFileSync(
    bundlePath,
    JSON.stringify({
      summary: 'Original evaluation',
      taskId: path.basename(dir),
      turnId: 'turn',
      questionRootId: 'question',
      sessionId: 'fixture-session',
      container: {
        containerId: fixtureContainerId,
        questionId: 'question',
        terminal,
      },
      traceExport,
    }),
  );
  const archiveArgs = {
    dir,
    turnId: 'turn',
    bundlePath,
    tracePath,
    automation: {},
    workDir,
  };
  const makeArchive = () => {
    const archive = createEvidenceArchive(archiveArgs);
    if (!archiveNative) {
      // Construct the former format as fixture data before testing migration.
      // Its evaluation has always retained the original export receipt.
      const manifest = JSON.parse(readFileSync(archive.manifestPath, 'utf8'));
      manifest.format = 3;
      delete manifest.nativeTrace;
      manifest.files = manifest.files.filter(
        (file) => !file.name.startsWith('native/'),
      );
      rmSync(path.join(archive.stageDir, 'native'), { recursive: true });
      writeFileSync(archive.manifestPath, JSON.stringify(manifest, null, 2));
      execFileSync('tar', [
        '-czf',
        archive.archivePath,
        '-C',
        archive.stageDir,
        '--',
        ...manifest.files.map((file) => file.name),
        'manifest.json',
      ]);
      archive.sha256 = hash(readFileSync(archive.archivePath));
      archive.manifestSha256 = hash(readFileSync(archive.manifestPath));
    }
    return archive;
  };
  let finalization;
  const makeFinalization = () => {
    if (finalization) return finalization;
    const finalRoot = path.join(
      dir,
      'question.final.traces-fixture',
      'projects',
    );
    mkdirSync(path.join(finalRoot, '-workspace/subagents/empty'), {
      recursive: true,
    });
    const finalContents = new Map(contents);
    finalContents.set(
      '-workspace/final-cleanup.jsonl',
      '{"type":"system","subtype":"fixture-final-cleanup"}\n',
    );
    const finalFiles = [...finalContents]
      .map(([name, content]) => {
        const bytes = Buffer.from(content);
        mkdirSync(path.dirname(path.join(finalRoot, name)), {
          recursive: true,
        });
        writeFileSync(path.join(finalRoot, name), bytes);
        return { name, bytes: bytes.length, sha256: hash(bytes) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const finalManifest = path.join(path.dirname(finalRoot), 'manifest.json');
    writeFileSync(
      finalManifest,
      JSON.stringify({ containerId: fixtureContainerId, files: finalFiles }),
    );
    writeTerminalFinalization(
      {
        taskId: path.basename(dir),
        questionId: 'question',
        sessionId: 'fixture-session',
        terminal,
        containerId: fixtureContainerId,
        status: 'removed',
        finalCommandTransport: 'original-mac-terminal',
        traceExport: {
          verified: true,
          path: finalRoot,
          manifestPath: finalManifest,
          files: finalFiles.length,
          sha256: hash(JSON.stringify(finalFiles)),
          exportKind: 'final',
        },
      },
      dir,
    );
    finalization = verifyTerminalFinalization({
      taskDir: dir,
      questionId: 'question',
      terminal,
    });
    assert(finalization);
    return finalization;
  };
  const makeSubmission = (archive, { finalize = true } = {}) => {
    const receipt = finalize ? makeFinalization() : null;
    return createSubmissionPackage({
      dir,
      turnId: 'turn',
      archive,
      traceExport: receipt?.traceExport || traceExport,
      finalization: receipt,
      knownSecrets: [secret],
    });
  };
  return {
    dir,
    workDir,
    secret,
    provider,
    traceExport,
    contents,
    archiveArgs,
    makeArchive,
    makeSubmission,
    makeFinalization,
    terminal,
    terminalState,
    get finalization() {
      return finalization;
    },
  };
}
function retain(f, archive) {
  return [
    archive.archivePath,
    archive.manifestPath,
    ...JSON.parse(readFileSync(archive.manifestPath, 'utf8')).files.map(
      (file) => path.join(archive.stageDir, file.name),
    ),
    f.traceExport.manifestPath,
    ...f.contents.keys().map((name) => path.join(f.traceExport.path, name)),
    path.join(f.workDir, 'app.js'),
  ].map((file) => [file, readFileSync(file)]);
}

test('SQLite engineering files stay byte-identical and are rescanned when verifying the package', (t) => {
  const f = fixture(t),
    file = path.join(f.workDir, 'fixture.sqlite3');
  execFileSync('python3', [
    '-c',
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE notes(value TEXT)'); c.execute('INSERT INTO notes VALUES(?)',('fixture-public-note-917',)); c.commit(); c.close()",
    file,
  ]);
  const original = readFileSync(file),
    archive = f.makeArchive();
  const submission = f.makeSubmission(archive);
  assert.equal(submission.status, 'passed');
  verifySubmissionPackage(submission, {
    dir: f.dir,
    sourceArchive: archive,
    knownSecrets: [f.secret],
  });
  const manifest = JSON.parse(readFileSync(submission.manifestPath));
  const row = manifest.files.find((r) => r.textFormat === 'sqlite');
  assert(row);
  assert.equal(row.originalSha256, row.submissionSha256);
  assert.deepEqual(
    readFileSync(path.join(path.dirname(submission.manifestPath), row.name)),
    original,
  );
  assert.deepEqual(readFileSync(file), original);
  assert.throws(
    () =>
      verifySubmissionPackage(submission, {
        dir: f.dir,
        sourceArchive: archive,
        knownSecrets: [f.secret, 'fixture-public-note-917'],
      }),
    /数据库内容/,
  );
});

test('native delivery keeps internal database warnings without bypassing source integrity', (t) => {
  const f = fixture(t),
    file = path.join(f.workDir, 'fixture.sqlite3');
  execFileSync('python3', [
    '-c',
    "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE notes(phone TEXT)'); c.execute('INSERT INTO notes VALUES(?)',('13800138000',)); c.commit(); c.close()",
    file,
  ]);
  const archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  assert.equal(submission.status, 'needs_review');
  const options = {
    dir: f.dir,
    sourceArchive: archive,
    purpose: 'native-only',
  };
  const verified = verifySubmissionPackage(submission, options);
  assert.equal(verified.status, 'passed');
  assert.equal(verified.contentScanStatus, 'needs_review');
  assert.ok(
    verified.internalWarnings.some(
      (x) => x.reason === 'sensitive-sqlite-content',
    ),
  );
  assert.throws(
    () =>
      verifySubmissionPackage(submission, {
        dir: f.dir,
        sourceArchive: archive,
      }),
    /人工复核/,
  );
  assert.throws(
    () =>
      verifySubmissionPackage(submission, {
        dir: f.dir,
        purpose: 'native-only',
      }),
    /源归档/,
  );
  const manifest = JSON.parse(readFileSync(submission.manifestPath));
  for (const file of [
    archive.archivePath,
    submission.zipArchivePath,
    submission.manifestPath,
    submission.finalization.receiptPath,
    path.join(path.dirname(submission.manifestPath), manifest.files[0].name),
  ]) {
    const original = readFileSync(file);
    writeFileSync(file, 'changed');
    assert.throws(() => verifySubmissionPackage(submission, options));
    writeFileSync(file, original);
  }
  assert.equal(verifySubmissionPackage(submission, options).status, 'passed');
  const pending = f.makeSubmission(archive, { finalize: false });
  assert.throws(() => verifySubmissionPackage(pending, options));
});

test('internal archive captures full native directory and immutable retries retain the earlier archive', (t) => {
  const f = fixture(t),
    archive = f.makeArchive();
  const before = retain(f, archive);
  const names = execFileSync('tar', ['-tzf', archive.archivePath], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  for (const [name, content] of f.contents)
    assert.deepEqual(
      execFileSync('tar', [
        '-xOzf',
        archive.archivePath,
        'native/projects/' + name,
      ]),
      Buffer.from(content),
    );
  assert(names.includes('native/projects/-workspace/subagents/empty/'));
  const manifest = JSON.parse(readFileSync(archive.manifestPath, 'utf8'));
  assert.equal(manifest.nativeTrace.files, 3);
  assert.equal(manifest.nativeTrace.sha256, f.traceExport.sha256);
  assert.equal(
    verifyNativeExport(f.traceExport, {
      dir: f.dir,
      containerId: fixtureContainerId,
    }).files.length,
    3,
  );
  assert.throws(
    () =>
      verifyNativeExport(f.traceExport, { dir: f.dir, containerId: 'other' }),
    /容器身份/,
  );
  const second = f.makeArchive();
  assert.notEqual(second.archivePath, archive.archivePath);
  assert.notEqual(second.manifestPath, archive.manifestPath);
  for (const [file, bytes] of before)
    assert.deepEqual(readFileSync(file), bytes);
});

test('empty native export requires explicit opt-in and retains identity, digest and exact inventory checks', (t) => {
  const f = fixture(t);
  rmSync(f.traceExport.path, { recursive: true });
  mkdirSync(path.join(f.traceExport.path, '-workspace/empty'), {
    recursive: true,
  });
  writeFileSync(
    f.traceExport.manifestPath,
    JSON.stringify({ containerId: fixtureContainerId, files: [] }),
  );
  f.traceExport.files = 0;
  f.traceExport.sha256 = hash('[]');
  const bundle = JSON.parse(readFileSync(f.archiveArgs.bundlePath, 'utf8'));
  bundle.traceExport = f.traceExport;
  writeFileSync(f.archiveArgs.bundlePath, JSON.stringify(bundle));
  const options = {
    dir: f.dir,
    containerId: fixtureContainerId,
    allowEmpty: true,
  };
  assert.throws(() => verifyNativeExport(f.traceExport, { dir: f.dir }));
  assert.throws(() => f.makeArchive(), /清单摘要/);
  const verified = verifyNativeExport(f.traceExport, options);
  assert.deepEqual(verified.files, []);
  assert.deepEqual(verified.directories, ['-workspace', '-workspace/empty']);
  assert.throws(
    () =>
      verifyNativeExport(f.traceExport, { ...options, containerId: 'other' }),
    /容器身份/,
  );
  assert.throws(
    () =>
      verifyNativeExport({ ...f.traceExport, sha256: 'a'.repeat(64) }, options),
    /清单摘要/,
  );
  writeFileSync(
    path.join(f.traceExport.path, '-workspace/extra.jsonl'),
    '{}\n',
  );
  assert.throws(() => verifyNativeExport(f.traceExport, options), /文件集合/);
});

for (const [label, mutate] of [
  [
    'missing file',
    (f) => rmSync(path.join(f.traceExport.path, '-workspace/notes.txt')),
  ],
  [
    'extra file',
    (f) =>
      writeFileSync(
        path.join(f.traceExport.path, '-workspace/extra.txt'),
        'extra',
      ),
  ],
  [
    'changed bytes',
    (f) =>
      writeFileSync(
        path.join(f.traceExport.path, '-workspace/notes.txt'),
        'changed',
      ),
  ],
  [
    'symlink file',
    (f) => {
      const file = path.join(f.traceExport.path, '-workspace/notes.txt');
      rmSync(file);
      symlinkSync(path.join(f.workDir, 'app.js'), file);
    },
  ],
  [
    'symlink parent',
    (f) => {
      const folder = path.join(f.traceExport.path, '-workspace/subagents');
      rmSync(folder, { recursive: true });
      symlinkSync(f.workDir, folder);
    },
  ],
  [
    'escaping path',
    (f) => {
      const m = JSON.parse(readFileSync(f.traceExport.manifestPath, 'utf8'));
      m.files[0].name = '../outside.jsonl';
      writeFileSync(f.traceExport.manifestPath, JSON.stringify(m));
      f.traceExport.sha256 = hash(JSON.stringify(m.files));
    },
  ],
  [
    'duplicate manifest name',
    (f) => {
      const m = JSON.parse(readFileSync(f.traceExport.manifestPath, 'utf8'));
      m.files[1].name = m.files[0].name;
      writeFileSync(f.traceExport.manifestPath, JSON.stringify(m));
      f.traceExport.sha256 = hash(JSON.stringify(m.files));
    },
  ],
])
  test('full native export rejects ' + label, (t) => {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => verifyNativeExport(f.traceExport, { dir: f.dir }));
  });

test('submission ZIP preserves all native structure, redacts text with mappings and verifies bound hashes', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    before = retain(f, archive);
  const submission = f.makeSubmission(archive);
  assert.equal(submission.status, 'passed');
  const verified = verifySubmissionPackage(submission, {
    dir: f.dir,
    sourceArchive: archive,
    traceExport: f.finalization.traceExport,
    maxBytes: 20 * 1024 * 1024,
  });
  assert.equal(verified.passed, true);
  const zip = unzipSync(readFileSync(submission.zipArchivePath));
  const manifest = JSON.parse(
    Buffer.from(zip['manifest.json']).toString('utf8'),
  );
  assert.equal(manifest.nativeFiles, 4);
  assert(zip['native/projects/-workspace/subagents/empty/']);
  assert(zip['source-turn/native/projects/-workspace/subagents/empty/']);
  assert(zip['source-turn/native/projects/-workspace/main.jsonl']);
  assert(zip['native/projects/-workspace/final-cleanup.jsonl']);
  assert.notEqual(submission.traceExportSha256, f.traceExport.sha256);
  assert.equal(manifest.sourceTurnTraceExportSha256, f.traceExport.sha256);
  assert.equal(
    manifest.finalizationReceiptSha256,
    f.finalization.receiptSha256,
  );
  assert.equal(
    JSON.parse(Buffer.from(zip['evaluation.json']).toString('utf8')).traceExport
      .sha256,
    f.traceExport.sha256,
  );
  for (const kind of ['known-secret', 'provider-token', 'email', 'phone'])
    assert(
      manifest.redactions.some((item) => item.kind === kind && item.count > 0),
    );
  for (const file of manifest.files) {
    const bytes = Buffer.from(zip[file.name]);
    assert.equal(hash(bytes), file.submissionSha256);
    assert.equal(bytes.length, file.submissionBytes);
    assert.equal(bytes.includes(Buffer.from(f.secret)), false);
    assert.equal(bytes.includes(Buffer.from(f.provider)), false);
    assert.equal(
      sanitizeSensitiveText(bytes.toString('utf8')).findings.length,
      0,
    );
  }
  for (const [name, content] of f.contents) {
    const file = manifest.files.find(
      (item) =>
        item.source === 'native-export' &&
        item.sourceNameSha256 === hash('native/projects/' + name),
    );
    assert.equal(file.originalSha256, hash(Buffer.from(content)));
    assert(zip[file.name]);
  }
  const lines = Buffer.from(zip['native/projects/-workspace/main.jsonl'])
    .toString('utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(lines[1].phone, '[REDACTED_PHONE]');
  assert.throws(
    () =>
      verifySubmissionPackage(submission, {
        dir: f.dir,
        maxBytes: submission.zipBytes - 1,
      }),
    /大小上限/,
  );
  for (const [file, bytes] of before)
    assert.deepEqual(readFileSync(file), bytes);
});

test('intermediate copies await finalization and finalized derivatives never relabel or rewrite them', (t) => {
  const f = fixture(t),
    archive = f.makeArchive();
  const pending = f.makeSubmission(archive, { finalize: false });
  assert.equal(pending.status, 'awaiting_finalization');
  assert.equal(pending.contentScanStatus, 'passed');
  const pendingBytes = readFileSync(pending.zipArchivePath);
  assert.throws(
    () => verifySubmissionPackage(pending, { dir: f.dir }),
    /最终导出/,
  );
  const final = f.makeSubmission(archive);
  assert.equal(final.status, 'passed');
  assert.notEqual(final.zipArchivePath, pending.zipArchivePath);
  assert.deepEqual(readFileSync(pending.zipArchivePath), pendingBytes);
  assert.equal(pending.status, 'awaiting_finalization');
  assert.throws(
    () =>
      verifySubmissionPackage(final, {
        dir: f.dir,
        traceExport: f.traceExport,
      }),
    /最终完成回执/,
  );
  const binary = fixture(t, { binary: true });
  const unscanned = binary.makeSubmission(binary.makeArchive(), {
    finalize: false,
  });
  assert.equal(unscanned.status, 'needs_review');
  assert.equal(unscanned.contentScanStatus, 'needs_review');
});

test('final packages recheck the full receipt, original session and terminal completion before every use', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  const final = f.finalization;
  const create = (receipt = final) =>
    createSubmissionPackage({
      dir: f.dir,
      turnId: 'turn',
      archive,
      traceExport: receipt.traceExport,
      finalization: receipt,
      knownSecrets: [f.secret],
    });
  for (const patch of [
    { status: 'exported' },
    { status: 'postprocessing' },
    { postprocessingComplete: false },
    { verifiedExport: false },
    { containerRemoved: false },
    { runId: 'another-run' },
    { containerId: 'b'.repeat(64) },
  ]) {
    writeFileSync(
      f.terminal.statePath,
      JSON.stringify({ ...f.terminalState, ...patch }),
    );
    assert.throws(() => create(), /后处理/);
    assert.throws(
      () => verifySubmissionPackage(submission, { dir: f.dir }),
      /后处理/,
    );
  }
  writeFileSync(f.terminal.statePath, JSON.stringify(f.terminalState));
  for (const patch of [
    { receiptSha256: 'b'.repeat(64) },
    { taskId: 'other-task' },
    { questionId: 'other-question' },
    { containerId: 'b'.repeat(64) },
  ])
    assert.throws(() => create({ ...final, ...patch }), /回执/);
  const original = readFileSync(final.receiptPath);
  const recorded = JSON.parse(original);
  writeFileSync(
    final.receiptPath,
    JSON.stringify({ ...recorded, sessionId: 'other-session' }),
  );
  const changed = verifyTerminalFinalization({
    taskDir: f.dir,
    questionId: 'question',
    terminal: f.terminal,
  });
  assert(changed);
  assert.throws(() => create(changed), /身份/);
  assert.throws(
    () => verifySubmissionPackage(submission, { dir: f.dir }),
    /回执/,
  );
  writeFileSync(final.receiptPath, original);
  assert.equal(
    verifySubmissionPackage(submission, { dir: f.dir }).passed,
    true,
  );
  rmSync(final.receiptPath);
  assert.throws(() => verifySubmissionPackage(submission, { dir: f.dir }));
});

test('legacy transport and missing session binding remain review-only after valid final export', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    final = f.makeFinalization();
  const original = JSON.parse(readFileSync(final.receiptPath, 'utf8'));
  for (const patch of [
    { commandTransport: 'legacy-runner-migration' },
    { sessionId: null },
  ]) {
    writeFileSync(final.receiptPath, JSON.stringify({ ...original, ...patch }));
    const receipt = verifyTerminalFinalization({
      taskDir: f.dir,
      questionId: 'question',
      terminal: f.terminal,
    });
    assert(receipt);
    const submission = createSubmissionPackage({
      dir: f.dir,
      turnId: 'turn',
      archive,
      traceExport: receipt.traceExport,
      finalization: receipt,
      knownSecrets: [f.secret],
    });
    assert.equal(submission.status, 'needs_review');
    assert.equal(submission.contentScanStatus, 'passed');
    assert.throws(
      () => verifySubmissionPackage(submission, { dir: f.dir }),
      /人工复核/,
    );
  }
});

test('final package binds the original turn to its archive even after the intermediate export is unavailable', (t) => {
  const f = fixture(t),
    archive = f.makeArchive();
  f.makeFinalization();
  rmSync(path.dirname(f.traceExport.path), { recursive: true });
  const submission = f.makeSubmission(archive);
  assert.equal(
    verifySubmissionPackage(submission, { dir: f.dir, sourceArchive: archive })
      .passed,
    true,
  );
});

test('a legacy internal archive can gain a complete native submission derivative without being rewritten', (t) => {
  const f = fixture(t, { archiveNative: false }),
    archive = f.makeArchive(),
    before = retain(f, archive);
  assert.equal(
    JSON.parse(readFileSync(archive.manifestPath, 'utf8')).nativeTrace,
    undefined,
  );
  const submission = f.makeSubmission(archive);
  assert.equal(
    verifySubmissionPackage(submission, {
      dir: f.dir,
      traceExport: f.finalization.traceExport,
    }).passed,
    true,
  );
  for (const [file, bytes] of before)
    assert.deepEqual(readFileSync(file), bytes);
});

test('archive and submission reject a valid export belonging to another container or question', (t) => {
  const f = fixture(t),
    archive = f.makeArchive();
  for (const differentContent of [false, true]) {
    const root = path.join(f.dir, 'other-' + differentContent, 'projects');
    const files = [];
    for (const [name, content] of f.contents) {
      const bytes = Buffer.from(
        String(content) + (differentContent ? '\n' : ''),
      );
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), bytes);
      files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    const manifestPath = path.join(path.dirname(root), 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        containerId: differentContent ? fixtureContainerId : 'other-container',
        files,
      }),
    );
    const traceExport = {
      verified: true,
      path: root,
      manifestPath,
      files: files.length,
      sha256: hash(JSON.stringify(files)),
    };
    assert.equal(
      verifyNativeExport(traceExport, { dir: f.dir }).files.length,
      files.length,
    );
    assert.throws(
      () => createEvidenceArchive({ ...f.archiveArgs, traceExport }),
      /身份|评测回执/,
    );
    assert.throws(
      () =>
        createSubmissionPackage({
          dir: f.dir,
          turnId: 'turn',
          archive,
          traceExport,
          knownSecrets: [f.secret],
        }),
      /身份|评测回执/,
    );
  }
  assert.throws(
    () =>
      createSubmissionPackage({
        dir: f.dir,
        turnId: 'other-turn',
        archive,
        traceExport: f.traceExport,
      }),
    /身份回执/,
  );
});

test('sensitive native filenames are mapped without losing hierarchy or exposing the original name', (t) => {
  const f = fixture(t);
  const name = '-workspace/person@fixture-email.local/session.jsonl';
  const content = '{"message":"non-sensitive evidence"}\n';
  f.contents.set(name, content);
  mkdirSync(path.dirname(path.join(f.traceExport.path, name)), {
    recursive: true,
  });
  writeFileSync(path.join(f.traceExport.path, name), content);
  const m = JSON.parse(readFileSync(f.traceExport.manifestPath, 'utf8'));
  m.files.push({
    name,
    bytes: Buffer.byteLength(content),
    sha256: hash(content),
  });
  m.files.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(f.traceExport.manifestPath, JSON.stringify(m));
  f.traceExport.files = m.files.length;
  f.traceExport.sha256 = hash(JSON.stringify(m.files));
  const evaluation = JSON.parse(readFileSync(f.archiveArgs.bundlePath, 'utf8'));
  evaluation.traceExport = f.traceExport;
  writeFileSync(f.archiveArgs.bundlePath, JSON.stringify(evaluation));
  const archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  const zip = unzipSync(readFileSync(submission.zipArchivePath));
  const manifest = JSON.parse(
    Buffer.from(zip['manifest.json']).toString('utf8'),
  );
  const mapped = manifest.files.find(
    (file) =>
      file.source === 'native-export' &&
      file.sourceNameSha256 === hash('native/projects/' + name),
  );
  assert(
    mapped.name.startsWith('native/projects/-workspace/[REDACTED_EMAIL].'),
  );
  assert(mapped.name.endsWith('/session.jsonl'));
  assert.equal(Buffer.from(zip[mapped.name]).toString('utf8'), content);
  assert(!Object.keys(zip).join('\n').includes('person@fixture-email.local'));
  assert(
    !Buffer.from(zip['manifest.json'])
      .toString('utf8')
      .includes('person@fixture-email.local'),
  );
  assert.equal(
    verifySubmissionPackage(submission, {
      dir: f.dir,
      traceExport: f.finalization.traceExport,
    }).passed,
    true,
  );
});

test('unscannable binary remains byte-identical in the full derivative and cannot pass upload verification', (t) => {
  const f = fixture(t, { binary: true }),
    archive = f.makeArchive();
  const submission = f.makeSubmission(archive);
  assert.equal(submission.status, 'needs_review');
  assert(
    submission.reviewRequiredFiles.some((file) =>
      file.name.endsWith('/image.png'),
    ),
  );
  const zip = unzipSync(readFileSync(submission.zipArchivePath));
  assert.deepEqual(
    Buffer.from(zip['native/projects/-workspace/image.png']),
    f.contents.get('-workspace/image.png'),
  );
  assert.throws(
    () => verifySubmissionPackage(submission, { dir: f.dir }),
    /人工复核/,
  );
});

test('modified ZIP, staged file, scan report and original archive are rejected before use', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  const manifest = JSON.parse(readFileSync(submission.manifestPath, 'utf8'));
  for (const file of [
    submission.zipArchivePath,
    submission.verificationPath,
    submission.manifestPath,
    path.join(path.dirname(submission.manifestPath), manifest.files[0].name),
    archive.archivePath,
  ]) {
    const original = readFileSync(file);
    writeFileSync(file, 'changed');
    assert.throws(
      () =>
        verifySubmissionPackage(submission, {
          dir: f.dir,
          sourceArchive: archive,
        }),
      undefined,
      file,
    );
    writeFileSync(file, original);
  }
  assert.equal(
    verifySubmissionPackage(submission, { dir: f.dir, sourceArchive: archive })
      .passed,
    true,
  );
});

test('ZIP member validation still rejects extra content when a new transport hash is supplied', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  const zip = unzipSync(readFileSync(submission.zipArchivePath));
  zip['extra-secret.txt'] = Buffer.from('unexpected');
  const bytes = zipSync(zip);
  writeFileSync(submission.zipArchivePath, bytes);
  submission.zipSha256 = hash(bytes);
  submission.zipBytes = bytes.length;
  const { verificationPath, verificationSha256: _old, ...record } = submission;
  writeFileSync(verificationPath, JSON.stringify(record, null, 2));
  submission.verificationSha256 = hash(readFileSync(verificationPath));
  assert.throws(
    () => verifySubmissionPackage(submission, { dir: f.dir }),
    /额外成员/,
  );
});

test('ZIP symbolic links are rejected even when transport hashes are recomputed', (t) => {
  const f = fixture(t),
    archive = f.makeArchive(),
    submission = f.makeSubmission(archive);
  const bytes = readFileSync(submission.zipArchivePath);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert(central >= 0);
  bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  writeFileSync(submission.zipArchivePath, bytes);
  submission.zipSha256 = hash(bytes);
  const { verificationPath, verificationSha256: _old, ...record } = submission;
  writeFileSync(verificationPath, JSON.stringify(record, null, 2));
  submission.verificationSha256 = hash(readFileSync(verificationPath));
  assert.throws(
    () => verifySubmissionPackage(submission, { dir: f.dir }),
    /特殊文件/,
  );
});
