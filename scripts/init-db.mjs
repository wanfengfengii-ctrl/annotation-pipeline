import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function databaseSetupAction(tables) {
  const applicationTables = [
    'tasks',
    'runners',
    'review_history',
    'export_batches',
    'export_items',
    'project_names',
  ];
  if (
    applicationTables.some((name) => tables.includes(name)) &&
    !tables.includes('d1_migrations')
  )
    throw Error(
      '检测到旧版手动初始化数据库，已停止；请备份后按部署说明升级，不要重复初始化。',
    );
  return 'migrate';
}

export function initializeDatabase({ cwd = root, persistTo } = {}) {
  const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const options = [
    '--local',
    '--config',
    path.join(cwd, 'wrangler.local.json'),
  ];
  if (persistTo) options.push('--persist-to', path.resolve(persistTo));
  const run = (args) =>
    execFileSync(process.execPath, [cli, 'd1', ...args, ...options], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
  const response = JSON.parse(
    run([
      'execute',
      'DB',
      '--json',
      '--command',
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ]),
  );
  if (
    !Array.isArray(response) ||
    response.length !== 1 ||
    response.some(
      (item) => item.success !== true || !Array.isArray(item.results),
    )
  )
    throw Error('无法确认本地数据库状态，未执行迁移。');
  databaseSetupAction(
    response.flatMap((item) => item.results.map((row) => row.name)),
  );
  run(['migrations', 'apply', 'DB']);
  console.log('本地数据库迁移已完成；重复执行只应用未执行的迁移。');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    initializeDatabase();
  } catch (error) {
    // Child diagnostics can include environment-specific configuration.
    console.error(
      error.status === undefined
        ? error.message
        : '本地数据库迁移失败，已有数据保留；请检查数据库与迁移文件。',
    );
    process.exitCode = 1;
  }
}
