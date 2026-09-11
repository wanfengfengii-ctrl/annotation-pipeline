// Verification-only helpers. They observe the actual page without choosing a
// replacement selector, dispatching synthetic events or suppressing assertions.
async function pageControls(page) {
  let timer;
  const controls = page
    .locator('input,select,textarea,button,a,[role],[aria-label]')
    .evaluateAll((nodes) =>
      nodes.slice(0, 60).map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        role: el.getAttribute('role'),
        name: el.getAttribute('aria-label'),
        labels: Array.from(el.labels || []).map((l) =>
          l.textContent.trim().slice(0, 120),
        ),
        text: /^(INPUT|TEXTAREA)$/.test(el.tagName)
          ? ''
          : (el.textContent || '').trim().slice(0, 120),
        disabled: !!el.disabled,
        visible: !!el.getClientRects().length,
      })),
    );
  try {
    return await Promise.race([
      controls,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('页面控件读取超时')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function withPageDiagnostics(page, work) {
  try {
    return await work();
  } catch (error) {
    try {
      console.log(
        'VERIFICATION_BROWSER_CONTEXT ' +
          JSON.stringify(await pageControls(page)),
      );
    } catch (diagnosticError) {
      console.log(
        'VERIFICATION_BROWSER_CONTEXT_UNAVAILABLE ' + diagnosticError.name,
      );
    }
    throw error;
  }
}
async function unique(locator) {
  const deadline = performance.now() + 5000;
  let detached = false;
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0)
      throw Error(
        'VERIFICATION_LOCATOR_UNSTABLE expected=1 actual=0 timeout=5000',
      );
    // first() is only an attachment wait. Never return or act on that narrowed
    // locator: count every match again after the wait, including after rerenders.
    await locator.first().waitFor({ state: 'attached', timeout: remaining });
    const count = await locator.count();
    if (count === 1) return locator;
    if (count !== 0)
      throw Error('VERIFICATION_LOCATOR_COUNT expected=1 actual=' + count);
    if (!detached) {
      console.log(
        'VERIFICATION_LOCATOR_RETRY expected=1 actual=0 reason=detached_after_wait',
      );
      detached = true;
    }
    // It existed during waitFor but disappeared before count. Re-resolve the
    // same locator within the original deadline; do not reset the timeout.
  }
}
module.exports = { pageControls, withPageDiagnostics, unique };
