import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  initialCodeVersion,
  initialSnapshotSubject,
  validateInitialCodeSnapshot,
} from '../lib/initial-code-snapshot.mjs';
const hash = (v, algorithm = 'sha256') =>
  createHash(algorithm).update(v).digest('hex');
export const gitBlob = (v) =>
  hash(Buffer.concat([Buffer.from(`blob ${v.length}\0`), v]), 'sha1');
const uuid = (v) => /^[a-f0-9-]{36}$/.test(v || '');
function saveReceipt(file, value) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
function safeName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('/') ||
    /[\\\x00-\x1f]/.test(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..') ||
    /(^|\/)(\.git|\.claude|\.codex|\.ssh|\.aws|\.npmrc|\.pypirc|\.netrc|\.dev\.vars|\.env[^/]*|credentials[^/]*|[^/]*\.(pem|key|p12))($|\/)/i.test(
      name,
    ) ||
    name === 'SNAPSHOT.json'
  )
    throw Error('初始代码包含不能发布的路径');
  return name;
}
export function frozenInitialFiles(container) {
  const subject = initialSnapshotSubject(container);
  const bytes = readFileSync(subject.manifestPath);
  if (hash(bytes) !== subject.sha256) throw Error('初始代码清单哈希不匹配');
  const manifest = JSON.parse(bytes);
  const entries =
    subject.kind === 'scaffold'
      ? manifest.files
      : manifest.files.filter((f) => f.name.startsWith('workspace/'));
  if (!entries.length || entries.length > 10000)
    throw Error('初始代码文件数量无效');
  const names = new Set();
  let total = 0;
  const files = entries.map((f) => {
    const name = safeName(
      subject.kind === 'scaffold'
        ? `${manifest.directory}/${f.path}`
        : f.name.slice('workspace/'.length),
    );
    if (names.has(name)) throw Error('初始代码文件路径重复');
    names.add(name);
    let content;
    if (subject.kind === 'scaffold') content = Buffer.from(f.content, 'utf8');
    else {
      const root = realpathSync(path.dirname(subject.manifestPath)),
        src = path.resolve(root, f.name);
      if (
        !src.startsWith(root + path.sep) ||
        !lstatSync(src).isFile() ||
        realpathSync(src) !== src
      )
        throw Error('冻结代码不能使用符号链接或越界路径');
      content = readFileSync(src);
    }
    if (hash(content) !== f.sha256) throw Error(`冻结代码哈希不匹配：${name}`);
    total += content.length;
    if (content.length > 10 * 1024 * 1024 || total > 32 * 1024 * 1024)
      throw Error('初始代码超过发布大小限制');
    if (
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/.test(
        content.toString('utf8'),
      )
    )
      throw Error(`初始代码含凭据样式内容，未发布：${name}`);
    return {
      name,
      content,
      sha256: f.sha256,
      mode: f.executable || f.mode & 0o111 ? '100755' : '100644',
    };
  });
  if (files.length !== subject.files)
    throw Error('初始代码文件数量与清单不一致');
  return { subject, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
}
export function assertRemoteTree(tree, files) {
  const actual = tree.tree
    ?.filter((f) => f.type !== 'tree')
    .map((f) => ({ path: f.path, mode: f.mode, type: f.type, sha: f.sha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const expected = files
    .map((f) => ({
      path: f.name,
      mode: f.mode,
      type: 'blob',
      sha: gitBlob(f.content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (tree.truncated || JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error('GitHub 文件树与冻结初始代码不一致');
}
function command(cmd, args, cwd, input) {
  return execFileSync(cmd, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 40 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Annotation Pipeline',
      GIT_AUTHOR_EMAIL: 'annotation-pipeline@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Annotation Pipeline',
      GIT_COMMITTER_EMAIL: 'annotation-pipeline@users.noreply.github.com',
    },
  }).trim();
}
export function publishInitialCode(
  { taskId, questionId, container, workRoot, publicationMode = 'before-run' },
  run = command,
) {
  if (!uuid(taskId) || !uuid(questionId))
    throw Error('初始快照任务或原题标识无效');
  const { subject, files } = frozenInitialFiles(container);
  const dir = path.join(workRoot, taskId, 'initial-snapshots', questionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(dir, 'publication.json');
  const saved = existsSync(receiptPath)
    ? JSON.parse(readFileSync(receiptPath, 'utf8'))
    : null;
  if (
    saved &&
    (saved.manifestSha256 !== subject.sha256 ||
      saved.imageSnapshot !== container.snapshot)
  )
    throw Error('已发布初始快照不可更换');
  const owner = run('gh', ['api', 'user', '--jq', '.login']);
  if (!/^[\w-]+$/.test(owner)) throw Error('GitHub 登录账号无效');
  const repository = `${owner}/annotation-initial-${taskId}`,
    description = `Annotation Pipeline initial code snapshots for task ${taskId}`;
  if (saved && saved.repository !== repository)
    throw Error('初始快照账号已变化，不能自动迁移');
  const meta = saved?.metadata || {
    version: initialCodeVersion,
    taskId,
    questionId,
    manifestSha256: subject.sha256,
    imageSnapshot: container.snapshot,
    publicationMode,
    publishedAt: new Date().toISOString(),
    files: files.map((f) => ({ path: f.name, sha256: f.sha256 })),
  };
  const all = [
    ...files,
    {
      name: 'SNAPSHOT.json',
      content: Buffer.from(JSON.stringify(meta, null, 2) + '\n'),
      mode: '100644',
    },
  ];
  const repo = path.join(dir, 'repository.git');
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  const git = (args, input) =>
    run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.helper=',
        '-c',
        'credential.helper=!gh auth git-credential',
        ...args,
      ],
      repo,
      input,
    );
  let state = saved;
  if (!state) {
    git(['init', '--bare']);
    git(['read-tree', '--empty']);
    const index = all
      .map(
        (f) =>
          `${f.mode} ${git(['hash-object', '-w', '--stdin'], f.content)}\t${f.name}\0`,
      )
      .join('');
    git(['update-index', '-z', '--index-info'], index);
    const tree = git(['write-tree']);
    const sha = git(
      ['commit-tree', tree],
      `Initial code for question ${questionId}\nFrozen manifest SHA-256: ${subject.sha256}\nPublication: ${publicationMode}\n`,
    );
    git(['update-ref', `refs/heads/question-${questionId}`, sha]);
    state = {
      version: initialCodeVersion,
      engine: 'github-cli-initial-code',
      taskId,
      questionId,
      repository,
      sha,
      tree,
      url: `https://github.com/${repository}/commit/${sha}`,
      isPrivate: true,
      files: files.length,
      manifestSha256: subject.sha256,
      imageSnapshot: container.snapshot,
      publicationMode,
      metadata: meta,
    };
    saveReceipt(receiptPath, state);
  }
  let remote;
  try {
    remote = JSON.parse(run('gh', ['api', `repos/${repository}`]));
  } catch (e) {
    if (!/HTTP 404/.test(String(e.stderr || e.message))) throw e;
    run('gh', [
      'repo',
      'create',
      repository,
      '--private',
      '--description',
      description,
    ]);
    remote = JSON.parse(run('gh', ['api', `repos/${repository}`]));
  }
  if (
    !remote.private ||
    remote.full_name !== repository ||
    remote.description !== description
  )
    throw Error('目标不是本任务专用的私有快照仓库');
  const remoteURL = `https://github.com/${repository}.git`,
    ref = `refs/heads/question-${questionId}`;
  const existing = git(['ls-remote', '--refs', remoteURL, ref]).split(/\s+/)[0];
  if (existing && existing !== state.sha)
    throw Error('远端初始快照分支已变化，不覆盖已有提交');
  if (!existing) git(['push', remoteURL, `${state.sha}:${ref}`]);
  const commit = JSON.parse(
    run('gh', ['api', `repos/${repository}/git/commits/${state.sha}`]),
  );
  if (commit.sha !== state.sha || commit.tree.sha !== state.tree)
    throw Error('GitHub 初始快照提交不匹配');
  assertRemoteTree(
    JSON.parse(
      run('gh', [
        'api',
        `repos/${repository}/git/trees/${state.tree}?recursive=1`,
      ]),
    ),
    all,
  );
  state.verifiedAt = new Date().toISOString();
  validateInitialCodeSnapshot(state, taskId, questionId, container);
  saveReceipt(receiptPath, state);
  const { metadata, ...record } = state;
  return record;
}
export class InitialCodePublisher {
  publish(options) {
    return publishInitialCode(options);
  }
}
