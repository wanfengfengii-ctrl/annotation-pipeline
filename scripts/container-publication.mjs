import { setTimeout as sleep } from 'node:timers/promises';

// The API replaces one task's container record. Retry only this identical,
// sequential publication, never terminal input or Claude reservations. Keeping
// this at the job boundary also works with an older runner's API callback.
export async function publishContainerState(report, state, pause = sleep) {
  const snapshot = structuredClone(state);
  for (let attempt = 0; ; attempt++) {
    try {
      return await report(structuredClone(snapshot));
    } catch (error) {
      const gateway =
        /^执行器接口 container：HTTP (502|503|504)(，响应不是有效的 JSON)?$/.test(
          error.message,
        );
      const cause = error.cause;
      const network =
        error.message?.startsWith('执行器接口 container：') &&
        (['AbortError', 'TimeoutError'].includes(cause?.name) ||
          (cause instanceof TypeError &&
            ['fetch failed', 'terminated'].includes(cause.message)));
      if (attempt >= 2 || (!gateway && !network)) throw error;
      await pause(250 * 2 ** attempt);
    }
  }
}
