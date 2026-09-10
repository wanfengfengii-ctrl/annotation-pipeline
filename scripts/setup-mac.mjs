import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from './init-db.mjs';
import {
  containerImage,
  resolveContainerImage,
} from '../lib/container-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === '--check';
function check(command, args, message) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch {
    throw Error(message);
  }
}
function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

try {
  if (args.length && !checkOnly)
    throw Error('只支持 npm run setup:mac 或 npm run check:mac。');
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw Error(
      '当前固定镜像仅验证 Apple Silicon Mac，请使用 ARM64 Node.js；Intel Mac 尚未验证。',
    );
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw Error('需要 Node.js 22.13 或更新版本。');
  for (const command of ['git', 'codex', 'gh'])
    check(command, ['--version'], '请先安装 ' + command);
  check(
    '/usr/bin/python3',
    ['-c', 'import sqlite3, pty, termios'],
    '请安装 Xcode Command Line Tools，真实 Terminal 桥接需要系统 /usr/bin/python3。',
  );
  check(
    'codex',
    ['login', 'status'],
    '请先运行 codex login 完成 Codex CLI 登录。',
  );
  check(
    'gh',
    ['auth', 'status'],
    '请先运行 gh auth login 完成 GitHub CLI 登录。',
  );
  check(
    'docker',
    ['info', '--format', '{{.OSType}}'],
    '请启动 Docker Desktop，等待引擎就绪。',
  );
  const settingsFile = path.join(os.homedir(), '.claude/settings.json');
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    throw Error(
      '请先在本机配置 ~/.claude/settings.json，沿用已确认的服务商配置。',
    );
  }
  if (
    typeof settings?.env?.ANTHROPIC_AUTH_TOKEN !== 'string' ||
    !settings.env.ANTHROPIC_AUTH_TOKEN.trim()
  )
    throw Error(
      '本机尚未配置 Claude 服务认证；安装程序不会复制或改写模型、网关、密钥。',
    );
  if (!existsSync(path.join(root, 'node_modules/wrangler/bin/wrangler.js')))
    throw Error('请先运行 npm ci 安装项目依赖。');
  let image;
  try {
    image = JSON.parse(
      execFileSync('docker', ['image', 'inspect', containerImage], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      }),
    )[0];
  } catch {
    /* A fresh machine builds the pinned image below. */
  }
  if (image) resolveContainerImage(image);
  console.log('Mac、CLI 登录、Docker 和服务认证检查通过。');
  if (checkOnly) {
    console.log(
      image
        ? '固定作业镜像已就绪。'
        : '尚未构建作业镜像，运行 npm run setup:mac 完成安装。',
    );
    console.log(
      '此检查未发送模型请求；真实 Terminal 权限和镜像内上下文由作业预检核验。',
    );
  } else {
    run(process.execPath, ['scripts/init-local.mjs']);
    initializeDatabase();
    if (!image)
      run('docker', [
        'build',
        '--pull=false',
        '--platform',
        'linux/arm64',
        '--tag',
        containerImage,
        'docker/claude-webdeps',
      ]);
    resolveContainerImage(
      JSON.parse(
        check(
          'docker',
          ['image', 'inspect', containerImage],
          '固定作业镜像构建后未找到。',
        ),
      )[0],
    );
    run('npm', ['run', 'build']);
    console.log(
      '安装完成。在两个 Terminal 窗口分别运行 API_WORK_ROOT="$PWD" npm run api:local 和 npm run runner，打开 http://localhost:3000。',
    );
  }
} catch (error) {
  console.error(
    error.status === undefined
      ? error.message
      : '安装步骤失败，修正后可重新运行；已有账号与数据库不会重置。',
  );
  process.exitCode = 1;
}
