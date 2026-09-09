import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  frozenInitialFiles,
  publishInitialCode,
  assertRemoteTree,
  gitBlob,
} from '../scripts/initial-code-snapshot.mjs';
import {
  initialCodeVersion,
  validateInitialCodeSnapshot,
} from '../lib/initial-code-snapshot.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const taskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  questionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'initial-code-'));
  const content = 'initial placeholder\n',
    data = JSON.stringify({
      directory: 'projects/demo',
      files: [
        { path: 'main.py', content, sha256: hash(content), executable: false },
      ],
    });
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, data);
  const container = {
    snapshot: 'docker://image@sha256:' + 'd'.repeat(64),
    scaffoldSnapshot: { manifestPath, sha256: hash(data), files: 1 },
  };
  return {
    root,
    container,
    options: { taskId, questionId, container, workRoot: root },
  };
}
test('仅使用冻结骨架，校验清单与每个文件，拒绝篡改和凭据', () => {
  const f = fixture();
  try {
    assert.equal(
      frozenInitialFiles(f.container).files[0].content.toString(),
      'initial placeholder\n',
    );
    const p = f.container.scaffoldSnapshot.manifestPath;
    let m = JSON.parse(readFileSync(p));
    m.files[0].content = 'modified';
    writeFileSync(p, JSON.stringify(m));
    assert.throws(() => frozenInitialFiles(f.container), /清单哈希/);
    f.container.scaffoldSnapshot.sha256 = hash(readFileSync(p));
    assert.throws(() => frozenInitialFiles(f.container), /代码哈希/);
    m.files[0].content = 'sk-' + 'a'.repeat(25);
    m.files[0].sha256 = hash(m.files[0].content);
    writeFileSync(p, JSON.stringify(m));
    f.container.scaffoldSnapshot.sha256 = hash(readFileSync(p));
    assert.throws(() => frozenInitialFiles(f.container), /凭据/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('源码快照从冻结证据读取，不读正在变化的项目；越界和父级符号链接被拒绝', () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.root, 'workspace'));
    writeFileSync(path.join(f.root, 'workspace/main.py'), 'frozen');
    const data = JSON.stringify({
      files: [
        { name: 'workspace/main.py', sha256: hash('frozen'), mode: 0o755 },
      ],
    });
    const p = path.join(f.root, 'source.json');
    writeFileSync(p, data);
    const c = {
      sourceSnapshot: { manifestPath: p, sha256: hash(data), files: 1 },
    };
    assert.equal(frozenInitialFiles(c).files[0].mode, '100755');
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.root, 'workspace/link'));
    writeFileSync(path.join(outside, 'main.py'), 'frozen');
    const changed = JSON.stringify({
      files: [{ name: 'workspace/link/main.py', sha256: hash('frozen') }],
    });
    writeFileSync(p, changed);
    c.sourceSnapshot.sha256 = hash(changed);
    assert.throws(() => frozenInitialFiles(c), /符号链接/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('真实 Git 对象与模拟远端文件树核验，发布重试复用同一提交且不重复创建或推送', () => {
  const f = fixture();
  let exists = false,
    pushes = 0,
    creates = 0,
    remoteSha = '',
    cwd;
  const run = (cmd, args, dir, input) => {
    if (cmd === 'git') {
      cwd = dir;
      if (args.includes('ls-remote'))
        return remoteSha
          ? remoteSha + '\trefs/heads/question-' + questionId
          : '';
      if (args.includes('push')) {
        pushes++;
        remoteSha = args.at(-1).split(':')[0];
        return '';
      }
      return execFileSync('/usr/bin/git', args, {
        cwd: dir,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim();
    }
    if (args[0] === 'repo') {
      creates++;
      exists = true;
      return '';
    }
    if (args[1] === 'user') return 'fixture-owner';
    if (args[1].includes('/git/commits/'))
      return JSON.stringify({
        sha: remoteSha,
        tree: { sha: run('git', ['rev-parse', remoteSha + '^{tree}'], cwd) },
      });
    if (args[1].includes('/git/trees/')) {
      const raw = run('git', ['ls-tree', '-r', '-z', remoteSha], cwd);
      return JSON.stringify({
        truncated: false,
        tree: raw
          .split('\0')
          .filter(Boolean)
          .map((s) => {
            const [left, name] = s.split('\t');
            const [mode, type, sha] = left.split(' ');
            return { mode, type, sha, path: name };
          }),
      });
    }
    if (!exists) throw Object.assign(Error('HTTP 404'), { stderr: 'HTTP 404' });
    return JSON.stringify({
      private: true,
      full_name: `fixture-owner/annotation-initial-${taskId}`,
      description: `Annotation Pipeline initial code snapshots for task ${taskId}`,
    });
  };
  try {
    const a = publishInitialCode(
        { ...f.options, publicationMode: 'backfill' },
        run,
      ),
      b = publishInitialCode(f.options, run);
    assert.equal(a.sha, b.sha);
    assert.equal(a.publicationMode, 'backfill');
    assert.equal(b.publicationMode, 'backfill');
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
    validateInitialCodeSnapshot(b, taskId, questionId, f.container);
    assert.throws(
      () =>
        validateInitialCodeSnapshot(
          { ...b, manifestSha256: '0'.repeat(64) },
          taskId,
          questionId,
          f.container,
        ),
      /不一致/,
    );
    const state = JSON.parse(
      readFileSync(
        path.join(
          f.root,
          taskId,
          'initial-snapshots',
          questionId,
          'publication.json',
        ),
      ),
    );
    assert.equal(state.version, initialCodeVersion);
    remoteSha = 'e'.repeat(40);
    assert.throws(() => publishInitialCode(f.options, run), /分支已变化/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('远端多文件、漏文件、截断或模式变化均不能标记成功', () => {
  const files = [
    { name: 'main', mode: '100644', content: Buffer.from('initial') },
  ];
  const tree = {
    tree: [
      {
        path: 'main',
        type: 'blob',
        mode: '100644',
        sha: gitBlob(files[0].content),
      },
    ],
  };
  assertRemoteTree(tree, files);
  assert.throws(
    () => assertRemoteTree({ ...tree, truncated: true }, files),
    /不一致/,
  );
  assert.throws(() => assertRemoteTree({ tree: [] }, files), /不一致/);
  assert.throws(
    () =>
      assertRemoteTree(
        { tree: [...tree.tree, { ...tree.tree[0], path: 'extra' }] },
        files,
      ),
    /不一致/,
  );
});
