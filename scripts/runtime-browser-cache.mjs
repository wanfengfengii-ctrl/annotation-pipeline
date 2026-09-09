import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const browserCacheVersion = '2026-09-10.browser-cache1';
export const browserToolVersion = '1.55.0';
export const browserCacheMount = '/opt/annotation-runtime-tools';
const buildBudgetSeconds = 900;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inflight = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function browserCacheKey(imageId, platform) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || ''))
    throw Error('验收工具缓存缺少不可变镜像 ID');
  if (!/^linux\/(arm64|amd64)$/.test(platform || ''))
    throw Error('验收工具缓存不支持此镜像平台');
  return hash(JSON.stringify({ imageId, platform, browserToolVersion }));
}

function inventory(root) {
  const files = [],
    base = realpathSync(root) + path.sep;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name),
        rel = path.relative(root, file),
        stat = lstatSync(file);
      if (rel === 'ready.json') continue;
      if (stat.isSymbolicLink()) {
        if (!realpathSync(file).startsWith(base))
          throw Error('验收工具缓存含外部符号链接');
        files.push({ path: rel, target: readlinkSync(file) });
      } else if (stat.isDirectory()) walk(file);
      else if (stat.isFile())
        files.push({
          path: rel,
          bytes: stat.size,
          sha256: hash(readFileSync(file)),
        });
      else throw Error('验收工具缓存含非普通文件');
    }
  }
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function readRuntimeBrowserCache({ cacheRoot, imageId, platform }) {
  const key = browserCacheKey(imageId, platform),
    root = path.join(cacheRoot, key),
    readyPath = path.join(root, 'ready.json');
  if (!existsSync(readyPath)) return null;
  try {
    if (
      lstatSync(root).isSymbolicLink() ||
      lstatSync(readyPath).isSymbolicLink()
    )
      return null;
    const manifest = JSON.parse(readFileSync(readyPath, 'utf8'));
    if (
      manifest.version !== browserCacheVersion ||
      manifest.imageId !== imageId ||
      manifest.platform !== platform ||
      manifest.toolVersion !== browserToolVersion ||
      manifest.smoke?.passed !== true ||
      manifest.smoke?.toolVersion !== browserToolVersion ||
      !manifest.smoke?.browserVersion ||
      JSON.stringify(inventory(root)) !== JSON.stringify(manifest.files)
    )
      return null;
    const proof = JSON.parse(
      readFileSync(path.join(root, 'browser-smoke.json'), 'utf8'),
    );
    if (JSON.stringify(proof) !== JSON.stringify(manifest.smoke)) return null;
    const buildLog = manifest.preparation?.logPath;
    if (
      !buildLog ||
      !realpathSync(buildLog).startsWith(realpathSync(cacheRoot) + path.sep) ||
      hash(readFileSync(buildLog)) !== manifest.preparation.logSha256
    )
      return null;
    const executable = path.resolve(root, manifest.smoke.executable);
    if (
      !realpathSync(executable).startsWith(realpathSync(root) + path.sep) ||
      !lstatSync(executable).isFile() ||
      !manifest.files.some(
        (f) => f.path === 'tools/node_modules/playwright/package.json',
      )
    )
      return null;
    return {
      root,
      key,
      version: browserCacheVersion,
      imageId,
      platform,
      toolVersion: browserToolVersion,
      manifestPath: readyPath,
      manifestSha256: hash(readFileSync(readyPath)),
      smoke: manifest.smoke,
      preparation: manifest.preparation,
      mountPath: browserCacheMount,
      modulePath: browserCacheMount + '/tools/node_modules/playwright',
      browsersPath: browserCacheMount + '/browsers',
    };
  } catch {
    return null;
  }
}

const buildCommand = `set -Eeuo pipefail
mkdir -p /cache/tools /cache/browsers
printf '{"private":true}\\n' > /cache/tools/package.json
npm install --prefix /cache/tools --ignore-scripts --no-audit --no-fund --save-exact playwright@${browserToolVersion}
node /cache/tools/node_modules/playwright/cli.js install-deps chromium
node /cache/tools/node_modules/playwright/cli.js install --only-shell chromium
node <<'CACHE_SMOKE'
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/cache/tools/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<title>cache-ready</title><canvas></canvas>');
    const actual = await page.evaluate(() => ({ title: document.title, canvas: !!document.querySelector('canvas').getContext('2d') }));
    if (actual.title !== 'cache-ready' || !actual.canvas) throw Error('Browser smoke failed');
    const shellDirectory = fs.readdirSync('/cache/browsers').find(name => name.startsWith('chromium_headless_shell-'));
    function findShell(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isFile() && item.name === 'headless_shell') return file; if (item.isDirectory()) { const found = findShell(file); if (found) return found; } } }
    const executable = shellDirectory && findShell(path.join('/cache/browsers', shellDirectory));
    if (!executable) throw Error('Verified headless shell executable missing');
    const proof = { passed: true, toolVersion: require('/cache/tools/node_modules/playwright/package.json').version, browserVersion: browser.version(), executable: path.relative('/cache', executable), checkedAt: new Date().toISOString(), actual };
    fs.writeFileSync('/cache/browser-smoke.json', JSON.stringify(proof));
    console.log('BROWSER_CACHE_SMOKE_PASSED ' + proof.toolVersion + ' ' + proof.browserVersion);
  } finally { await browser.close(); }
})().catch(error => { console.error('BROWSER_CACHE_BLOCKED ' + error.message); process.exitCode = 2; });
CACHE_SMOKE`;

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function acquireLock(lockPath, deadline, getReady) {
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  while (Date.now() < deadline) {
    const ready = getReady();
    if (ready) return { ready };
    try {
      writeFileSync(lockPath, JSON.stringify(owner), {
        flag: 'wx',
        mode: 0o600,
      });
      return { owner };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let raw, existing;
      try {
        raw = readFileSync(lockPath, 'utf8');
        existing = JSON.parse(raw);
      } catch {
        throw Error('验收工具缓存锁无效，未接管未知构建');
      }
      if (
        !Number.isInteger(existing.pid) ||
        existing.pid <= 0 ||
        !existing.token
      )
        throw Error('验收工具缓存锁无效，未接管未知构建');
      if (!ownerAlive(existing.pid)) {
        if (readFileSync(lockPath, 'utf8') === raw) unlinkSync(lockPath);
        continue;
      }
      await delay(1000);
    }
  }
  throw Error('等待验收工具缓存准备超时，未重复启动下载');
}

async function prepare({
  imageId,
  cacheRoot,
  platform,
  docker,
  onChild,
  budgetSeconds,
}) {
  const key = browserCacheKey(imageId, platform),
    root = path.join(cacheRoot, key),
    deadline = Date.now() + budgetSeconds * 1000,
    lockPath = path.join(cacheRoot, key + '.lock'),
    getReady = () => readRuntimeBrowserCache({ cacheRoot, imageId, platform });
  mkdirSync(cacheRoot, { recursive: true });
  const lock = await acquireLock(lockPath, deadline, getReady);
  if (lock.ready) return lock.ready;
  const attempt = randomUUID(),
    staging = path.join(cacheRoot, '.' + key + '.building-' + attempt),
    name = 'annotation-browser-cache-' + attempt,
    logPath = path.join(cacheRoot, key + '.build-' + attempt + '.log');
  let failure, result;
  try {
    mkdirSync(staging);
    const run = await docker(
      [
        'run',
        '--rm',
        '--name',
        name,
        '--label',
        'annotation.browser-cache=true',
        '--cpus',
        '1',
        '--memory',
        '1g',
        '--pids-limit',
        '256',
        '--user',
        '0:0',
        '--security-opt',
        'no-new-privileges',
        '--env',
        'BASH_ENV=',
        '--env',
        'ENV=',
        '--env',
        'PLAYWRIGHT_BROWSERS_PATH=/cache/browsers',
        '--mount',
        `type=bind,source=${staging},target=/cache`,
        '--workdir',
        '/cache',
        '--entrypoint',
        '/bin/bash',
        imageId,
        '--noprofile',
        '--norc',
        '-c',
        buildCommand,
      ],
      {
        timeoutSeconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)),
        onChild,
        logPath,
      },
    );
    if (run.exitCode !== 0 || run.timedOut || run.limited)
      throw Error('验收浏览器缓存准备阻塞；未发布半成品；日志：' + logPath);
    const smoke = JSON.parse(
      readFileSync(path.join(staging, 'browser-smoke.json'), 'utf8'),
    );
    if (
      smoke.passed !== true ||
      smoke.toolVersion !== browserToolVersion ||
      !smoke.browserVersion ||
      smoke.actual?.title !== 'cache-ready' ||
      smoke.actual?.canvas !== true
    )
      throw Error('验收浏览器缓存缺少真实启动验证，未发布缓存');
    const manifest = {
      version: browserCacheVersion,
      imageId,
      platform,
      toolVersion: browserToolVersion,
      smoke,
      files: inventory(staging),
      preparedAt: new Date().toISOString(),
      preparation: {
        logPath,
        logSha256: run.logSha256,
        timeoutSeconds: budgetSeconds,
      },
    };
    writeFileSync(
      path.join(staging, 'ready.json'),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 },
    );
    if (existsSync(root))
      renameSync(root, path.join(cacheRoot, '.' + key + '.invalid-' + attempt));
    renameSync(staging, root);
    result = getReady();
    if (!result) throw Error('验收浏览器缓存完整性验证失败');
  } catch (error) {
    failure = error;
  } finally {
    try {
      const cleanup = await docker(['rm', '--force', name]);
      if (
        cleanup.exitCode !== 0 &&
        !cleanup.output.includes('No such container')
      )
        failure = Error('验收浏览器缓存构建容器清理失败；容器：' + name);
    } catch {
      failure = Error('验收浏览器缓存构建容器清理失败；容器：' + name);
    }
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    try {
      if (JSON.parse(readFileSync(lockPath, 'utf8')).token === lock.owner.token)
        unlinkSync(lockPath);
    } catch {
      /* Never remove a lock now owned by another process. */
    }
  }
  if (failure) throw failure;
  return result;
}

export async function ensureRuntimeBrowserCache({
  imageId,
  cacheRoot,
  docker,
  onChild = () => {},
  budgetSeconds = buildBudgetSeconds,
}) {
  if (
    !Number.isInteger(budgetSeconds) ||
    budgetSeconds < 1 ||
    budgetSeconds > buildBudgetSeconds
  )
    throw Error('验收工具缓存准备预算必须在 1 至 900 秒内');
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId || ''))
    throw Error('验收工具缓存缺少不可变镜像 ID');
  const inspection = await docker(
    ['image', 'inspect', imageId, '--format', '{{.Os}}/{{.Architecture}}'],
    { timeoutSeconds: 15, onChild },
  );
  if (inspection.exitCode !== 0 || inspection.timedOut || inspection.limited)
    throw Error('无法确认验收镜像平台，未准备浏览器缓存');
  const platform = inspection.output.trim(),
    key = browserCacheKey(imageId, platform),
    pendingKey = path.resolve(cacheRoot) + ':' + key;
  if (inflight.has(pendingKey)) return inflight.get(pendingKey);
  const pending = prepare({
    imageId,
    cacheRoot,
    platform,
    docker,
    onChild,
    budgetSeconds,
  });
  inflight.set(pendingKey, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(pendingKey);
  }
}

export const runtimeBrowserCache = { ensure: ensureRuntimeBrowserCache };
