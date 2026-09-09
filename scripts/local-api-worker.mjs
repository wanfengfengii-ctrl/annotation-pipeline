import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function localWorkerOptions(config, persist) {
  if (
    !config ||
    !persist ||
    !path.isAbsolute(config) ||
    !path.isAbsolute(persist)
  )
    throw Error('API_WORKER_PATHS_INVALID');
  return {
    config,
    dev: {
      // Wrangler 4.92's inspector proxy accumulates Network response messages
      // while no DevTools client is attached. This fixed release needs neither
      // an inspector nor file watching; disabling it removes that buffer.
      inspector: false,
      watch: false,
      liveReload: false,
      remote: false,
      persist,
      server: { hostname: '127.0.0.1', port: 3000 },
      logLevel: 'warn',
    },
  };
}

export async function startLocalWorker(config, persist, startWorker) {
  const worker = await startWorker(localWorkerOptions(config, persist));
  try {
    await worker.ready;
    if ((await worker.inspectorUrl) !== undefined)
      throw Error('API_INSPECTOR_ENABLED');
    return worker;
  } catch (error) {
    await worker.dispose();
    throw error;
  }
}

async function main() {
  const [config, persist] = process.argv.slice(2);
  localWorkerOptions(config, persist);
  if (!existsSync(config) || !existsSync(persist))
    throw Error('API_WORKER_PATHS_MISSING');
  const { unstable_startWorker } = await import('wrangler');
  let closing;
  const starting = startLocalWorker(config, persist, unstable_startWorker);
  const onSignal = () => {
    closing ??= starting.then((worker) => worker.dispose());
    void closing.catch(() => {
      process.exitCode = 1;
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
  await starting;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error('[local-api-worker] failed');
    process.exitCode = 1;
  });
}
