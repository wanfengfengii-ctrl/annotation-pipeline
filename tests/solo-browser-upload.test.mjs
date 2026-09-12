import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { attachSoloTrace } from '../scripts/solo-browser-upload.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-chooser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const bytes = Buffer.from('\ufeff{"type":"user", "text":"原文"}\r\n');
  fs.writeFileSync(file, bytes);
  const packet = {
    attachment: {
      path: file,
      name: 'session.jsonl',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteIdentical: true,
    },
  };
  const calls = [];
  let release;
  const tab = {
    url: async () => 'https://solo2.jzxhnh.com/app/submit',
    playwright: {
      waitForEvent: (event) => {
        calls.push(event);
        return new Promise((resolve) => {
          release = () =>
            resolve({ setFiles: async (files) => calls.push(files) });
        });
      },
    },
  };
  const uploadButton = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => {
      calls.push('click');
      release();
    },
  };
  t.mock.timers.enable({
    apis: ['Date'],
    now: new Date('2026-09-12T02:00:00Z'),
  });
  return { tab, uploadButton, packet, calls, file, bytes };
}

test('register chooser before one click, attach unchanged bytes, do not claim submitted', async (t) => {
  const f = fixture(t);
  const result = await attachSoloTrace(f);
  assert.deepEqual(f.calls, ['filechooser', 'click', [f.file]]);
  assert.deepEqual(fs.readFileSync(f.file), f.bytes);
  assert.equal(result.status, 'verification_required');
});

test('wrong origin and changed attachment never open or send a file', async (t) => {
  const f = fixture(t);
  f.tab.url = async () => 'https://example.com/app/submit';
  await assert.rejects(attachSoloTrace(f), /origin_mismatch/);
  f.tab.url = async () => 'https://solo2.jzxhnh.com/app/submit';
  fs.appendFileSync(f.file, 'changed');
  await assert.rejects(attachSoloTrace(f), /bytes_changed/);
  assert.deepEqual(f.calls, []);
});

test('chooser rejection is handled without a second click', async (t) => {
  const f = fixture(t);
  f.tab.playwright.waitForEvent = () => Promise.reject(new Error('timeout'));
  f.uploadButton.click = async () => {
    f.calls.push('click');
  };
  await assert.rejects(attachSoloTrace(f), /chooser_failed/);
  assert.deepEqual(f.calls, ['click']);
});

test('attachment cannot start overnight', async (t) => {
  const f = fixture(t);
  t.mock.timers.setTime(Date.parse('2026-09-12T17:00:00Z'));
  await assert.rejects(attachSoloTrace(f), /UPLOAD_PAUSED/);
  assert.deepEqual(f.calls, []);
});
