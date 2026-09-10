import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const timingVersion = '2026-09-10.attempt-timing1';
// Append observations; retries never overwrite a prior attempt's clocks.
export function attemptTiming({
  dir,
  taskId,
  turnId,
  release,
  now = () => Date.now(),
}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, turnId + '.timing.jsonl');
  const attemptId = randomUUID(),
    started = now();
  const emit = (event, extra = {}) =>
    appendFileSync(
      file,
      JSON.stringify({
        version: timingVersion,
        taskId,
        turnId,
        attemptId,
        release,
        event,
        at: new Date(now()).toISOString(),
        ...extra,
      }) + '\n',
      { mode: 0o600 },
    );
  emit('attempt-start');
  return {
    file,
    attemptId,
    async stage(name, work, { budget, kind } = {}) {
      const id = randomUUID(),
        queued = now();
      emit('stage-queued', { stage: name, spanId: id });
      const run = async () => {
        const start = now();
        emit('stage-start', {
          stage: name,
          spanId: id,
          queueMs: Math.max(0, start - queued),
        });
        try {
          const value = await work();
          emit('stage-end', {
            stage: name,
            spanId: id,
            outcome: 'completed',
            elapsedMs: Math.max(0, now() - start),
          });
          return value;
        } catch (error) {
          emit('stage-end', {
            stage: name,
            spanId: id,
            outcome: 'failed',
            elapsedMs: Math.max(0, now() - start),
          });
          throw error;
        }
      };
      return budget && kind ? budget.run(kind, taskId, name, run) : run();
    },
    finish(outcome) {
      emit('attempt-end', { outcome, elapsedMs: Math.max(0, now() - started) });
    },
  };
}

export function summarizeTiming(file) {
  if (!existsSync(file)) return [];
  const attempts = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.version !== timingVersion) continue;
    const a = attempts.get(e.attemptId) || {
      attemptId: e.attemptId,
      stages: [],
    };
    if (e.event === 'attempt-start') {
      a.startedAt = e.at;
      a.release = e.release;
    }
    if (e.event === 'attempt-end') {
      a.finishedAt = e.at;
      a.elapsedMs = e.elapsedMs;
      a.outcome = e.outcome;
    }
    if (e.event === 'stage-end')
      a.stages.push({
        stage: e.stage,
        elapsedMs: e.elapsedMs,
        outcome: e.outcome,
      });
    attempts.set(e.attemptId, a);
  }
  return [...attempts.values()];
}
