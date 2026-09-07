import { execFileSync } from 'node:child_process';
export const runCommand = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  }).trim();
export function githubRepository(remote) {
  const m = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  );
  if (!m) throw Error('快照需要 github.com 的 origin（HTTPS 或 SSH）');
  return `${m[1]}/${m[2]}`;
}
export function githubStatus(command = runCommand) {
  try {
    const version = command('gh', ['--version']).split('\n')[0];
    const login = command('gh', [
      'api',
      '--hostname',
      'github.com',
      'user',
      '--jq',
      '.login',
    ]);
    return {
      available: true,
      version,
      login,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      available: false,
      error:
        'GitHub CLI 未安装、未登录或无法访问 GitHub；请检查 gh auth status',
      checkedAt: new Date().toISOString(),
    };
  }
}
export function githubSnapshot(
  repoPath,
  { command = runCommand, expectedSha, existingSnapshot } = {},
) {
  const localHead = command('git', ['rev-parse', 'HEAD'], repoPath);
  if (!/^[a-f0-9]{40}$/i.test(localHead)) throw Error('本地 HEAD 不是完整 SHA');
  if (expectedSha && localHead !== expectedSha)
    throw Error('环境检查后 HEAD 已变化，请重新核验');
  let repository, sha;
  if (existingSnapshot) {
    const m = existingSnapshot.match(
      /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{40})$/i,
    );
    if (!m) throw Error('已有初始快照格式无效');
    [, repository, sha] = m;
  } else {
    if (command('git', ['status', '--porcelain'], repoPath))
      throw Error('初始仓库有未提交改动，请先提交需要评测的代码');
    repository = githubRepository(
      command('git', ['remote', 'get-url', 'origin'], repoPath),
    );
    sha = localHead;
  }
  const metadata = JSON.parse(
    command(
      'gh',
      [
        'repo',
        'view',
        repository,
        '--json',
        'nameWithOwner,url,isPrivate,viewerPermission,defaultBranchRef',
      ],
      repoPath,
    ),
  );
  if (
    !metadata.nameWithOwner ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
      metadata.url,
    )
  )
    throw Error('GitHub 仓库元数据无效');
  const canonical = metadata.nameWithOwner;
  const commit = JSON.parse(
    command(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/${canonical}/commits/${sha}`,
        '--jq',
        '{sha: .sha, html_url: .html_url}',
      ],
      repoPath,
    ),
  );
  const url = `${metadata.url}/commit/${sha}`;
  if (commit.sha !== sha || commit.html_url !== url)
    throw Error('GitHub 返回的提交与本地快照不一致');
  if (
    !existingSnapshot &&
    command('git', ['rev-parse', 'HEAD'], repoPath) !== sha
  )
    throw Error('获取快照期间 HEAD 已变化');
  return {
    url,
    sha,
    repository: canonical,
    isPrivate: metadata.isPrivate === true,
    viewerPermission: metadata.viewerPermission || 'UNKNOWN',
    defaultBranch: metadata.defaultBranchRef?.name || '',
    verifiedAt: new Date().toISOString(),
    engine: 'github-cli',
    accessNote: metadata.isPrivate
      ? '仅验证当前 gh 账号可访问；未验证其他评审者权限'
      : 'GitHub 公开仓库，已核验提交',
  };
}
