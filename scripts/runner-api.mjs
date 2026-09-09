import { setTimeout as sleep } from 'node:timers/promises';

// These actions only read state or write the same keyed value again. Never
// retry a claim, model reservation, enqueue or completion after an uncertain send.
const repeatable = new Set([
  'heartbeat',
  'supply-context',
  'stage',
  'initial-code-snapshot',
]);
const networkFailure = (error) =>
  ['AbortError', 'TimeoutError'].includes(error?.name) ||
  (error instanceof TypeError &&
    ['fetch failed', 'terminated'].includes(error.message));
const transientStatuses = new Set([502, 503, 504]);

export function createRunnerApi({
  base,
  token,
  request = fetch,
  pause = sleep,
}) {
  return async function api(body) {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      let response, value;
      try {
        response = await request(base + '/api/runner', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: payload,
          signal: AbortSignal.timeout(20000),
        });
        value = await response.json();
      } catch (error) {
        const invalidJson = response && error instanceof SyntaxError;
        if (
          repeatable.has(body.action) &&
          (networkFailure(error) ||
            (invalidJson && transientStatuses.has(response.status))) &&
          attempt < 2
        ) {
          await pause(250 * 2 ** attempt);
          continue;
        }
        // JSON parser errors may contain response text, including credentials.
        // Keep both the message and cause free of the untrusted response body.
        if (invalidJson)
          throw new Error(
            `执行器接口 ${body.action}：HTTP ${response.status}，响应不是有效的 JSON`,
          );
        const code = error?.cause?.code;
        throw new Error(
          `执行器接口 ${body.action}：${error.message}${code ? ` (${code})` : ''}`,
          { cause: error },
        );
      }
      if (!response.ok) {
        // A structured application error is authoritative, even with a gateway
        // status. Never replay business failures or uncertain non-keyed writes.
        if (
          !value?.error &&
          repeatable.has(body.action) &&
          transientStatuses.has(response.status) &&
          attempt < 2
        ) {
          await pause(250 * 2 ** attempt);
          continue;
        }
        throw new Error(
          `执行器接口 ${body.action}：${value?.error || `HTTP ${response.status}`}`,
        );
      }
      return value;
    }
  };
}
