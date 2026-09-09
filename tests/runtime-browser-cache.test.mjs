import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  browserCacheKey,
  browserToolVersion,
  ensureRuntimeBrowserCache,
  readRuntimeBrowserCache,
} from '../scripts/runtime-browser-cache.mjs';

const imageId = 'sha256:' + 'a'.repeat(64),
  platform = 'linux/arm64';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const cacheRoot = mkdtempSync(
    path.join(os.tmpdir(), 'runtime-browser-cache-'),
  );
  t.after(() => rmSync(cacheRoot, { recursive: true, force: true }));
  return cacheRoot;
}
function fakeDocker({ failure = false, noSmoke = false, buildDelay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    docker: async (args, options = {}) => {
      calls.push({ args, options });
      let output = args[0] === 'image' ? platform : 'removed';
      let exitCode = 0;
      if (args[0] === 'run') {
        const mount = args[args.indexOf('--mount') + 1];
        const staging = mount.match(
          /^type=bind,source=(.*),target=\/cache$/,
        )[1];
        const shell =
          'browsers/chromium_headless_shell-1187/chrome-linux/headless_shell';
        mkdirSync(path.dirname(path.join(staging, shell)), { recursive: true });
        writeFileSync(path.join(staging, shell), 'synthetic executable');
        mkdirSync(path.join(staging, 'tools/node_modules/playwright'), {
          recursive: true,
        });
        writeFileSync(
          path.join(staging, 'tools/node_modules/playwright/package.json'),
          JSON.stringify({ version: browserToolVersion }),
        );
        if (buildDelay)
          await new Promise((resolve) => setTimeout(resolve, buildDelay));
        if (!noSmoke)
          writeFileSync(
            path.join(staging, 'browser-smoke.json'),
            JSON.stringify({
              passed: true,
              toolVersion: browserToolVersion,
              browserVersion: '140.0.fixture',
              executable: shell,
              actual: { title: 'cache-ready', canvas: true },
            }),
          );
        output = failure
          ? 'download incomplete'
          : 'BROWSER_CACHE_SMOKE_PASSED fixture';
        exitCode = failure ? 2 : 0;
      }
      if (options.logPath) writeFileSync(options.logPath, output);
      return {
        output,
        exitCode,
        timedOut: false,
        limited: false,
        logPath: options.logPath,
        logSha256: hash(output),
      };
    },
  };
}
test('Cache publishes only verified immutable image/platform/tool contents and reuses without downloading', async (t) => {
  const cacheRoot = fixture(t),
    fake = fakeDocker();
  const cache = await ensureRuntimeBrowserCache({
    imageId,
    cacheRoot,
    docker: fake.docker,
  });
  assert.equal(cache.platform, platform);
  assert.equal(cache.toolVersion, '1.55.0');
  assert.equal(cache.smoke.passed, true);
  assert.equal(cache.manifestSha256, hash(readFileSync(cache.manifestPath)));
  const ready = JSON.parse(readFileSync(cache.manifestPath));
  assert(
    ready.files.some(
      (file) => file.path.endsWith('/headless_shell') && file.sha256,
    ),
  );
  assert(
    ready.files.some(
      (file) => file.path === 'tools/node_modules/playwright/package.json',
    ),
  );
  const again = await ensureRuntimeBrowserCache({
    imageId,
    cacheRoot,
    docker: fake.docker,
  });
  assert.equal(again.manifestSha256, cache.manifestSha256);
  assert.equal(fake.calls.filter((call) => call.args[0] === 'run').length, 1);
  const build = fake.calls.find((call) => call.args[0] === 'run');
  assert.equal(build.options.timeoutSeconds <= 900, true);
  assert.equal(build.args.filter((arg) => arg === '--mount').length, 1);
  assert(!build.args.some((arg) => arg.includes('/workspace')));
  assert(build.args.includes('PLAYWRIGHT_BROWSERS_PATH=/cache/browsers'));
  assert.match(build.args.at(-1), /playwright@1\.55\.0/);
  assert.match(build.args.at(-1), /install --only-shell chromium/);
  assert.match(build.args.at(-1), /chromium\.launch\(\{ headless: true \}\)/);
  assert.equal(existsSync(path.join(cacheRoot, cache.key + '.lock')), false);
});
test('Binary, preparation log, manifest identity and missing files cannot pass ready validation', async (t) => {
  const cacheRoot = fixture(t),
    fake = fakeDocker();
  const cache = await ensureRuntimeBrowserCache({
    imageId,
    cacheRoot,
    docker: fake.docker,
  });
  const context = { cacheRoot, imageId, platform };
  const executable = path.join(cache.root, cache.smoke.executable),
    original = readFileSync(executable);
  writeFileSync(executable, 'tampered');
  assert.equal(readRuntimeBrowserCache(context), null);
  writeFileSync(executable, original);
  const log = readFileSync(cache.preparation.logPath);
  writeFileSync(cache.preparation.logPath, 'tampered');
  assert.equal(readRuntimeBrowserCache(context), null);
  writeFileSync(cache.preparation.logPath, log);
  const manifest = readFileSync(cache.manifestPath),
    value = JSON.parse(manifest);
  writeFileSync(
    cache.manifestPath,
    JSON.stringify({ ...value, platform: 'linux/amd64' }),
  );
  assert.equal(readRuntimeBrowserCache(context), null);
  writeFileSync(cache.manifestPath, manifest);
  assert.equal(
    readRuntimeBrowserCache({
      ...context,
      imageId: 'sha256:' + 'b'.repeat(64),
    }),
    null,
  );
  rmSync(executable);
  assert.equal(readRuntimeBrowserCache(context), null);
});
test('Failed and unverified builds remain unpublished, clear their lock and clean their exact container', async (t) => {
  for (const option of [{ failure: true }, { noSmoke: true }]) {
    const cacheRoot = fixture(t),
      fake = fakeDocker(option);
    await assert.rejects(
      ensureRuntimeBrowserCache({ imageId, cacheRoot, docker: fake.docker }),
    );
    assert.equal(
      readRuntimeBrowserCache({ cacheRoot, imageId, platform }),
      null,
    );
    assert.equal(
      readdirSync(cacheRoot).some(
        (name) => name.endsWith('.lock') || name.includes('.building-'),
      ),
      false,
    );
    const build = fake.calls.find((call) => call.args[0] === 'run');
    assert.deepEqual(fake.calls.at(-1).args, [
      'rm',
      '--force',
      build.args[build.args.indexOf('--name') + 1],
    ]);
    assert(readdirSync(cacheRoot).some((name) => name.endsWith('.log')));
  }
});
test('Concurrent callers share one build and a stale named lock can be recovered', async (t) => {
  const cacheRoot = fixture(t),
    fake = fakeDocker({ buildDelay: 20 });
  const key = browserCacheKey(imageId, platform);
  writeFileSync(
    path.join(cacheRoot, key + '.lock'),
    JSON.stringify({ pid: 2147483647, token: 'stale' }),
  );
  const [a, b] = await Promise.all([
    ensureRuntimeBrowserCache({ imageId, cacheRoot, docker: fake.docker }),
    ensureRuntimeBrowserCache({ imageId, cacheRoot, docker: fake.docker }),
  ]);
  assert.equal(a.manifestSha256, b.manifestSha256);
  assert.equal(fake.calls.filter((call) => call.args[0] === 'run').length, 1);
});
test('Unsupported image/platform and oversized preparation budget do not start downloads', async (t) => {
  const cacheRoot = fixture(t),
    fake = fakeDocker();
  await assert.rejects(
    ensureRuntimeBrowserCache({
      imageId,
      cacheRoot,
      docker: fake.docker,
      budgetSeconds: 901,
    }),
    /预算/,
  );
  await assert.rejects(
    ensureRuntimeBrowserCache({
      imageId: 'latest',
      cacheRoot,
      docker: fake.docker,
    }),
    /不可变/,
  );
  await assert.rejects(
    ensureRuntimeBrowserCache({
      imageId,
      cacheRoot,
      docker: async () => ({ exitCode: 0, output: 'darwin/arm64' }),
    }),
    /平台/,
  );
  assert.equal(fake.calls.length, 0);
});
