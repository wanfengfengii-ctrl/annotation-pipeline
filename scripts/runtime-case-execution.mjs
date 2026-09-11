import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { evidencePath } from './evidence.mjs';

export const runtimeCaseExecutionVersion = '2026-09-12.isolated-cases1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));
const cacheIdentity = (context, setup, check) => ({
  version: runtimeCaseExecutionVersion,
  taskId: context.taskId,
  turnId: context.turnId,
  imageId: context.imageId,
  source: context.source,
  prompt: context.prompt,
  acceptance: context.acceptance,
  helperSha256: context.helperSha256,
  setup: setup.map(({ timeoutSeconds: _timeoutSeconds, ...value }) => value),
  check: (({ timeoutSeconds: _timeoutSeconds, ...value }) => value)(check),
});

function readProgress(dir, key, expected) {
  try {
    const pointer = JSON.parse(
      fs.readFileSync(
        evidencePath(path.join(dir, 'runtime-progress', key + '.json'), dir),
      ),
    );
    const bytes = fs.readFileSync(evidencePath(pointer.path, dir));
    if (hash(bytes) !== pointer.sha256) return null;
    const value = JSON.parse(bytes);
    if (
      JSON.stringify(value.identity) !== JSON.stringify(expected) ||
      value.run.timedOut ||
      value.run.limited ||
      value.run.sourceChanged ||
      ![0, 1].includes(value.run.exitCode)
    )
      return null;
    const log = fs.readFileSync(evidencePath(value.run.logPath, dir));
    if (hash(log) !== value.run.logSha256) return null;
    for (const setup of value.run.setupRuns || []) {
      if (
        setup.exitCode !== 0 ||
        setup.timedOut ||
        setup.limited ||
        setup.sourceChanged ||
        hash(fs.readFileSync(evidencePath(setup.logPath, dir))) !==
          setup.logSha256
      )
        return null;
    }
    return { ...value, receipt: pointer, log };
  } catch {
    return null;
  }
}
function saveProgress(dir, key, identity, run) {
  const folder = path.join(dir, 'runtime-progress');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, key + '-' + randomUUID() + '.receipt.json');
  const value = JSON.stringify({ identity, run }, null, 2);
  fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
  const pointer = path.join(folder, key + '.json'),
    temp = pointer + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ path: file, sha256: hash(value) }), {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temp, pointer);
}

// Each business case gets a fresh source copy/container and runs its setup.
// No case can depend on files or service state left by a preceding case.
// Only this same logical question can recover its verified execution evidence.
export async function executeRuntimeCases({
  plan,
  context,
  dir,
  root,
  limits,
  retryContext,
  openCase,
  execute,
  closeCase,
  onStep = async () => {},
  onProgress = async () => {},
  now = Date.now,
}) {
  const started = now(),
    setup = plan.checks.filter((c) => c.kind === 'setup');
  const business = plan.checks.filter((c) => c.kind !== 'setup');
  const blocked = new Set(
    (retryContext?.checks || [])
      .filter((c) => c.outcome === 'blocked')
      .map((c) => c.id),
  );
  const runs = new Map(),
    attempts = [];
  const remaining = () =>
    Math.max(
      0,
      Math.floor(limits.totalTimeoutSeconds - (now() - started) / 1000),
    );
  const reusedIds = [];
  const completed = (run) =>
    [0, 1].includes(run.exitCode) &&
    !run.timedOut &&
    !run.limited &&
    !run.sourceChanged;
  const progress = async () => {
    const value = {
      version: runtimeCaseExecutionVersion,
      taskId: context.taskId,
      turnId: context.turnId,
      reusedIds: [...reusedIds],
      completedIds: business
        .filter((c) => completed(runs.get(c.id) || {}))
        .map((c) => c.id),
      producedOutput: attempts.some((a) =>
        [a.run, ...a.setupRuns].some(
          (r) => r?.producedOutput || r?.output?.trim(),
        ),
      ),
      attempts: attempts.length,
      elapsedSeconds: (now() - started) / 1000,
      budgetExhausted: remaining() === 0,
      remainingIds: business
        .filter((c) => !completed(runs.get(c.id) || {}))
        .map((c) => c.id),
    };
    const file = path.join(root, 'case-progress-' + randomUUID() + '.json');
    const bytes = JSON.stringify(value, null, 2);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    await onProgress({ ...value, path: file, sha256: hash(bytes) });
    return value;
  };
  for (const check of business) {
    await onStep(check.id);
    const identity = cacheIdentity(context, setup, check),
      key = jsonHash(identity);
    const prior = blocked.has(check.id)
      ? null
      : readProgress(dir, key, identity);
    if (prior) {
      const logPath = path.join(root, check.id + '.log');
      fs.writeFileSync(logPath, prior.log, { flag: 'wx', mode: 0o600 });
      runs.set(check.id, {
        ...prior.run,
        logPath,
        reusedFrom: {
          ...prior.receipt,
          logPath: prior.run.logPath,
          logSha256: prior.run.logSha256,
        },
      });
      reusedIds.push(check.id);
      await progress();
      continue;
    }
    if (!remaining()) break;
    // One bounded timeout retry, in a fresh case environment. The first
    // attempt's real log remains in attempts; it is never overwritten.
    for (let attempt = 0; attempt < 2; attempt++) {
      const folder = path.join(root, 'cases', check.id + '-' + attempt);
      fs.mkdirSync(folder, { recursive: true });
      let handle,
        run,
        setupFailed = false,
        cleanupError;
      const setupRuns = [];
      try {
        handle = await openCase(check, folder);
        for (const prerequisite of setup) {
          if (!remaining()) {
            setupFailed = true;
            break;
          }
          const result = await execute(handle, prerequisite, {
            timeoutSeconds: Math.min(
              prerequisite.timeoutSeconds,
              limits.stepTimeoutSeconds,
              remaining(),
            ),
            maxTimeoutSeconds: Math.min(limits.stepTimeoutSeconds, remaining()),
            logPath: path.join(folder, prerequisite.id + '.setup.log'),
          });
          const { output: _setupOutput, ...savedSetup } = result;
          const entry = {
            ...savedSetup,
            id: prerequisite.id,
            executedAt: new Date(now()).toISOString(),
          };
          setupRuns.push(entry);
          runs.set(prerequisite.id, entry);
          if (
            entry.exitCode !== 0 ||
            entry.timedOut ||
            entry.limited ||
            entry.sourceChanged
          ) {
            setupFailed = true;
            break;
          }
        }
        if (!setupFailed && remaining()) {
          run = await execute(handle, check, {
            timeoutSeconds: Math.min(
              check.timeoutSeconds * 2 ** attempt,
              limits.stepTimeoutSeconds,
              remaining(),
            ),
            maxTimeoutSeconds: Math.min(limits.stepTimeoutSeconds, remaining()),
            logPath: path.join(folder, check.id + '.log'),
          });
          run = {
            ...run,
            id: check.id,
            executedAt: new Date(now()).toISOString(),
            setupRuns,
          };
        }
      } finally {
        if (handle) {
          try {
            await closeCase(handle);
          } catch (error) {
            cleanupError = error;
          }
        }
      }
      attempts.push({
        id: check.id,
        attempt,
        setupRuns,
        ...(run ? { run } : {}),
        ...(cleanupError ? { cleanupFailed: true } : {}),
      });
      fs.writeFileSync(
        path.join(folder, 'attempt.json'),
        JSON.stringify(attempts.at(-1), null, 2),
        { flag: 'wx', mode: 0o600 },
      );
      if (run) {
        const { output: _output, ...saved } = run;
        runs.set(check.id, saved);
        if (!cleanupError && completed(run))
          saveProgress(dir, key, identity, saved);
      }
      await progress();
      if (cleanupError) throw cleanupError;
      if (!(run?.timedOut && attempt === 0 && remaining() > 0)) break;
    }
    if (!remaining()) break;
  }
  // On a fully recovered execution all setup evidence was produced by those
  // same-question cases. Copy it into this report's directory for LF views.
  for (const check of business) {
    const run = runs.get(check.id);
    for (const original of run?.setupRuns || []) {
      if (runs.has(original.id)) continue;
      const bytes = fs.readFileSync(evidencePath(original.logPath, dir));
      if (hash(bytes) !== original.logSha256)
        throw Error('恢复验收的准备日志摘要不符');
      const logPath = path.join(root, original.id + '.setup.log');
      fs.writeFileSync(logPath, bytes, { flag: 'wx', mode: 0o600 });
      runs.set(original.id, {
        ...original,
        logPath,
        reusedFrom: {
          logPath: original.logPath,
          logSha256: original.logSha256,
        },
      });
    }
  }
  const result = await progress();
  fs.writeFileSync(
    path.join(root, 'case-progress.json'),
    JSON.stringify(result, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  return {
    runs: plan.checks.filter((c) => runs.has(c.id)).map((c) => runs.get(c.id)),
    progress: result,
  };
}
