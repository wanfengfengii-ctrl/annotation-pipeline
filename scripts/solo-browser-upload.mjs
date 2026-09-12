import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertUploadWindow } from './solo-upload-window.mjs';

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

// Call only from CUA, with the current tab and one observed visible upload
// button. The packet must come from the current eligible batch's prepare output.
// This attaches a file only; visible upload completion, form verification,
// mark-sending and the single final submit remain the caller's responsibility.
export async function attachSoloTrace({ tab, uploadButton, packet }) {
  assertUploadWindow();
  if (
    typeof tab?.url !== 'function' ||
    typeof tab?.playwright?.waitForEvent !== 'function'
  )
    fail('attachment_control_unavailable');
  const checkOrigin = async () => {
    const url = new URL(await tab.url());
    if (
      url.origin !== 'https://solo2.jzxhnh.com' ||
      url.username ||
      url.password
    )
      fail('attachment_origin_mismatch');
  };
  await checkOrigin();
  if (
    (await uploadButton.count()) !== 1 ||
    !(await uploadButton.isVisible()) ||
    !(await uploadButton.isEnabled())
  )
    fail('attachment_button_unverified');
  const a = packet?.attachment;
  if (
    !a ||
    !path.isAbsolute(a.path || '') ||
    path.extname(a.path).toLowerCase() !== '.jsonl' ||
    a.name !== path.basename(a.path) ||
    a.byteIdentical !== true ||
    !Number.isInteger(a.bytes) ||
    a.bytes < 1 ||
    a.bytes > 20 * 1024 * 1024
  )
    fail('attachment_packet_invalid');
  const verifyBytes = () => {
    const bytes = fs.readFileSync(a.path);
    if (
      bytes.length !== a.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== a.sha256
    )
      fail('attachment_bytes_changed');
  };
  verifyBytes();
  // Register before clicking, and attach a rejection handler immediately.
  // Object.keys/prototype enumeration cannot discover a proxied browser API.
  const pending = tab.playwright
    .waitForEvent('filechooser', { timeoutMs: 10000 })
    .then(
      (chooser) => ({ chooser }),
      () => ({ failed: true }),
    );
  try {
    await uploadButton.click();
  } catch {
    fail('attachment_click_uncertain');
  }
  const result = await pending;
  if (result.failed || typeof result.chooser?.setFiles !== 'function')
    fail('attachment_chooser_failed');
  await checkOrigin();
  assertUploadWindow();
  verifyBytes();
  try {
    await result.chooser.setFiles([a.path]);
  } catch {
    fail('attachment_selection_uncertain');
  }
  return {
    status: 'verification_required',
    name: a.name,
    bytes: a.bytes,
    sha256: a.sha256,
    byteIdentical: true,
  };
}
