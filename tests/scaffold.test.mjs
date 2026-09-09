import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEvidenceArchive } from '../scripts/evidence.mjs';
import {
  validateScaffold,
  installScaffold,
} from '../scripts/project-scaffold.mjs';
import { terminalIssues } from '../lib/terminal-policy.mjs';
test('Scaffolds freeze initial source, preserve content and never overwrite changed code', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'scaffold-')),
    workDir = path.join(root, 'workspace');
  mkdirSync(workDir);
  const directory = 'projects/p-' + randomUUID(),
    value = {
      stack: 'Node',
      startup: 'node src/index.js',
      summary: '基础入口',
      files: [
        { path: 'src/index.js', content: 'export {};', executable: false },
      ],
    };
  const args = {
      value,
      workDir,
      directory,
      evidenceDir: path.join(root, 'snapshot'),
      tracePath: '/fixture/scaffold.jsonl',
    },
    s = installScaffold(args);
  assert.equal(s.importedAfterStartup, true);
  assert.equal(s.generatedBy, 'Codex CLI');
  assert.equal(s.sha256, installScaffold(args).sha256);
  const file = path.join(workDir, directory, 'src/index.js');
  assert.equal(readFileSync(file, 'utf8'), 'export {};');
  writeFileSync(file, 'changed');
  assert.throws(() => installScaffold(args), /覆盖/);
  const bundlePath = path.join(root, 'evaluation.json');
  const tracePath = path.join(root, 'trace.jsonl');
  writeFileSync(
    bundlePath,
    JSON.stringify({ container: { scaffoldSnapshot: s } }),
  );
  writeFileSync(tracePath, '{"type":"user"}\n');
  const archive = createEvidenceArchive({
    dir: root,
    turnId: 'baseline',
    bundlePath,
    tracePath,
    automation: {},
    workDir,
  });
  const archived = (name) =>
    execFileSync('tar', ['-xOzf', archive.archivePath, name], {
      encoding: 'utf8',
    });
  assert.equal(
    JSON.parse(archived('initial-scaffold.json')).files[0].content,
    'export {};',
  );
  assert.equal(archived('workspace/' + directory + '/src/index.js'), 'changed');
  writeFileSync(s.manifestPath, '{}');
  assert.throws(
    () =>
      createEvidenceArchive({
        dir: root,
        turnId: 'tampered',
        bundlePath,
        tracePath,
        automation: {},
        workDir,
      }),
    /scaffold hash mismatch/,
  );
  for (const name of [
    '../escape',
    '/tmp/escape',
    '.claude/settings.json',
    'CLAUDE.md',
    '.env',
  ])
    assert.throws(
      () =>
        validateScaffold({
          ...value,
          files: [{ ...value.files[0], path: name }],
        }),
      /路径/,
    );
  assert.throws(() =>
    validateScaffold({ ...value, files: Array(41).fill(value.files[0]) }),
  );
});
test('Delivery requires a real Mac Terminal identity, not a background PTY label', () => {
  assert.ok(terminalIssues({ container: {} }).length);
  assert.deepEqual(
    terminalIssues({
      container: {
        terminalIdentity: {
          transport: 'mac-terminal',
          runId: 'r',
          tty: '/dev/tty',
          realTerminal: true,
        },
      },
    }),
    [],
  );
  assert.ok(
    terminalIssues({
      container: {
        terminalIdentity: {
          transport: 'pty',
          runId: 'r',
          tty: '/dev/tty',
          realTerminal: true,
        },
      },
    }).length,
  );
});
