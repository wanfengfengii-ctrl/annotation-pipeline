// Explicit integration/browser check; the production address is rejected.
// PLAYWRIGHT_MODULE can point to the desktop's bundled Playwright installation.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { base } from './fixtures/test-server.mjs';
import { soloStatusSnapshot } from '../lib/solo-upload-status.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(
  fs.realpathSync('.').includes('annotation-pipeline-optimization-'),
  'Browser samples require the isolated optimization worktree',
);
const dir = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const file = fs
  .readdirSync(dir)
  .find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
const db = new DatabaseSync(path.join(dir, file));
const template = JSON.parse(
  fs.readFileSync('tests/fixtures/console-project.json', 'utf8'),
);
const ids = [],
  rows = [],
  samples = [];
for (let i = 0; i < 24; i++) {
  const id = randomUUID(),
    turnId = randomUUID();
  ids.push(id);
  const t = JSON.parse(
    JSON.stringify(template)
      .replaceAll(template.id, id)
      .replaceAll(template.turns[0].id, turnId)
      .replaceAll(template.sessionId, 'sample-session-' + i),
  );
  t.title = '本地交付样例 ' + String(i + 1).padStart(2, '0');
  t.turns[0].prompt = t.title + '，保存后保留当前筛选和页码。';
  t.turns[0].promptId = 'sample-message-' + i;
  t.createdAt =
    t.turns[0].createdAt =
    t.turns[0].finishedAt =
      new Date(Date.now() - i * 1000).toISOString();
  db.prepare(
    'INSERT INTO tasks(id,data,revision,created_at) VALUES(?,?,0,?)',
  ).run(id, JSON.stringify(t), t.createdAt);
  const key = id + ':' + turnId;
  rows.push({
    key,
    sourceDigest: 'a'.repeat(64),
    packetDigest: 'b'.repeat(64),
  });
  samples.push(t);
}
const slot = '2026-09-12T10:00:00+08:00';
const snapshot = soloStatusSnapshot(
  {
    entries: Object.fromEntries(
      rows.map((r, i) => [
        r.key,
        {
          state: 'prepared',
          updatedAt: new Date().toISOString(),
          displayIdentity: {
            sessionId: samples[i].sessionId,
            messageUuid: samples[i].turns[0].promptId,
            promptId: 'sample-native-' + i,
          },
        },
      ]),
    ),
  },
  { entries: {} },
  new Date().toISOString(),
  {
    runs: {
      [slot]: {
        status: 'waiting_login',
        createdAt: slot,
        members: rows,
        attempts: [],
      },
    },
  },
);
db.prepare(
  "INSERT INTO runners(id,data,heartbeat) VALUES('solo-upload',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,heartbeat=excluded.heartbeat",
).run(JSON.stringify(snapshot), snapshot.checkedAt);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  const hydrated = page.waitForResponse((r) => r.url() === base + '/api/tasks');
  await page.goto(base);
  await hydrated;
  await page.getByRole('tab', { name: '标注数据', exact: true }).click();
  const records = page.locator('.record-panel');
  await records
    .getByLabel('任务、Prompt 或会话', { exact: true })
    .fill('本地交付样例');
  await records.getByText('共 24 条 · 第 1 / 2 页', { exact: true }).waitFor();
  let release, observed;
  const held = new Promise((r) => {
    observed = r;
  });
  let armed = true;
  await page.route('**/api/records?**', async (route) => {
    if (
      armed &&
      new URL(route.request().url()).searchParams.get('page') === '1'
    ) {
      armed = false;
      // Obtain the real server response first, delaying only its delivery.
      const response = await route.fetch();
      await new Promise((r) => {
        release = r;
        observed();
      });
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await held; // the actual 15-second automatic poll
  await records.getByRole('button', { name: '下一页', exact: true }).click();
  await records.getByText('共 24 条 · 第 2 / 2 页', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('page'), '2');
  const before = await records.locator('tbody').innerText();
  release();
  await page.waitForTimeout(16500); // one subsequent real poll
  assert.equal(new URL(page.url()).searchParams.get('page'), '2');
  assert.equal(await records.locator('tbody').innerText(), before);
  // Open the original task from the batch, exercise persisted delivery versions.
  const batches = page.locator('.upload-batches-panel');
  await batches.locator('summary').first().click();
  await batches.getByRole('button', { name: '重新核验并续传本批' }).click();
  await batches
    .getByRole('status')
    .filter({ hasText: '已排队重新核验' })
    .waitFor();
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM runners WHERE id LIKE 'solo-recovery:%'")
      .get().n,
    1,
  );
  await batches
    .getByRole('button', { name: '查看原题 ' + rows[0].key, exact: true })
    .click();
  await page.getByRole('tab', { name: '交付追溯', exact: true }).click();
  const delivery = page.locator('.delivery-panel');
  await delivery.locator('summary').first().waitFor();
  await delivery.locator('summary').first().click();
  await delivery
    .getByText('原生 PromptID：sample-native-0', { exact: true })
    .waitFor();
  const response = await (
    await fetch(base + '/api/tasks/' + ids[0] + '/delivery')
  ).json();
  const oldVersion = response.version;
  const t = samples[0];
  t.turns[0].review.descriptions[0] = '修订后的交付说明';
  db.prepare('UPDATE tasks SET data=?,revision=revision+1 WHERE id=?').run(
    JSON.stringify(t),
    ids[0],
  );
  const next = await (
    await fetch(base + '/api/tasks/' + ids[0] + '/delivery')
  ).json();
  assert.notEqual(next.version, oldVersion);
  const previous = await (
    await fetch(
      base + '/api/tasks/' + ids[0] + '/delivery?version=' + oldVersion,
    )
  ).json();
  assert.notEqual(
    previous.entries[0].score.descriptions[0],
    '修订后的交付说明',
  );
  const download = page.waitForEvent('download');
  await delivery.getByRole('button', { name: '下载内部交付明细' }).click();
  await download;
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: '/tmp/annotation-optimization-delivery.png',
    fullPage: false,
  });
  console.log(
    'Browser checks passed: delayed real poll, latest page and URL, batch recovery intent, native ID mapping, immutable delivery history and download.',
  );
} finally {
  await browser.close();
  for (const id of ids) {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    db.prepare('DELETE FROM project_names WHERE task_id=?').run(id);
  }
  db.prepare(
    "DELETE FROM runners WHERE id='solo-upload' OR id LIKE 'solo-recovery:%'",
  ).run();
  db.close();
}
