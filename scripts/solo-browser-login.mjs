import { Buffer } from 'node:buffer';
import { SOLO_CREDENTIAL, withSoloCredential } from './solo-keychain.mjs';

const credentialErrors = new Set([
  'credential_missing',
  'keychain_locked_or_denied',
  'keychain_unavailable',
  'invalid_credential',
]);

class SoloLoginError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SoloLoginError';
    this.code = code;
  }
}

function fail(code) {
  throw new SoloLoginError(code);
}

async function checkOrigin(tab) {
  let url;
  try {
    url = new URL(await tab.url());
  } catch {
    fail('login_origin_unverified');
  }
  if (
    url.origin !== SOLO_CREDENTIAL.origin ||
    url.username !== '' ||
    url.password !== ''
  )
    fail('login_origin_mismatch');
}

async function checkForm(
  { tab, usernameField, passwordField, submitButton },
  { readyToSubmit = false } = {},
) {
  await checkOrigin(tab);
  for (const locator of [usernameField, passwordField, submitButton]) {
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
      fail('login_controls_unverified');
  }
  if ((await passwordField.getAttribute('type'))?.toLowerCase() !== 'password')
    fail('login_password_field_invalid');
  // Many login forms enable the button only after both fields are filled.
  if (readyToSubmit && !(await submitButton.isEnabled()))
    fail('login_submit_disabled');
  // A navigation during the checks must be noticed before any secret is used.
  await checkOrigin(tab);
}

/**
 * Submit one SOLO login through caller-provided CUA locators. The caller must
 * obtain all three locators from the observed login form in this exact tab.
 * This module does not discover, launch or connect to a browser. It never reads
 * field values, captures screenshots, writes cookies or logs a credential.
 *
 * credentialReader is an in-memory test seam; production uses Keychain. It must
 * invoke its callback once and must not persist or return the password. The
 * mutable Buffer is erased here and by withSoloCredential. The temporary string
 * required by CUA fill() is managed by JavaScript and cannot be explicitly wiped.
 *
 * A resolved result only means one login click completed. Observe the account
 * through CUA before recording an authenticated login receipt. If clicking
 * throws login_submission_uncertain, observe the page instead of retrying.
 */
export async function submitSoloLogin(
  { tab, usernameField, passwordField, submitButton },
  { credentialReader = withSoloCredential } = {},
) {
  const form = { tab, usernameField, passwordField, submitButton };
  let readStarted = false;
  let callbackStarted = false;
  let clickStarted = false;
  try {
    if (
      typeof tab?.url !== 'function' ||
      typeof credentialReader !== 'function' ||
      [usernameField, passwordField, submitButton].some(
        (locator) =>
          typeof locator?.count !== 'function' ||
          typeof locator?.isVisible !== 'function',
      ) ||
      typeof usernameField.fill !== 'function' ||
      typeof passwordField.fill !== 'function' ||
      typeof passwordField.getAttribute !== 'function' ||
      typeof submitButton.isEnabled !== 'function' ||
      typeof submitButton.click !== 'function'
    )
      fail('login_adapter_invalid');

    await checkForm(form);
    readStarted = true;
    const result = await credentialReader(async (credential) => {
      const password = credential?.password;
      try {
        if (callbackStarted) fail('credential_reader_invalid');
        callbackStarted = true;
        if (
          credential?.origin !== SOLO_CREDENTIAL.origin ||
          credential?.username !== SOLO_CREDENTIAL.username ||
          credential?.service !== SOLO_CREDENTIAL.service ||
          !Buffer.isBuffer(password) ||
          password.length === 0 ||
          password.length >= 4096
        )
          fail('invalid_credential');

        await checkForm(form);
        await usernameField.fill(SOLO_CREDENTIAL.username);
        await checkForm(form);
        await passwordField.fill(password.toString('utf8'));
        await checkForm(form, { readyToSubmit: true });
        clickStarted = true;
        await submitButton.click();
        return {
          status: 'verification_required',
          origin: SOLO_CREDENTIAL.origin,
          username: SOLO_CREDENTIAL.username,
          submitted: true,
        };
      } finally {
        if (Buffer.isBuffer(password)) password.fill(0);
      }
    });
    if (!callbackStarted || !clickStarted) fail('credential_reader_invalid');
    // Only the fixed receipt is exposed; an injected reader cannot return data.
    if (result?.status !== 'verification_required' || result.submitted !== true)
      fail('credential_reader_invalid');
    return {
      status: 'verification_required',
      origin: SOLO_CREDENTIAL.origin,
      username: SOLO_CREDENTIAL.username,
      submitted: true,
    };
  } catch (error) {
    // Locator errors may embed the fill argument. Never retain their message,
    // stack, cause or arbitrary properties in the outward-facing error.
    let code = 'login_action_failed';
    if (clickStarted) code = 'login_submission_uncertain';
    else if (error instanceof SoloLoginError) code = error.code;
    else if (readStarted && !callbackStarted)
      code = credentialErrors.has(error?.code)
        ? error.code
        : 'credential_unavailable';
    throw new SoloLoginError(code);
  }
}
