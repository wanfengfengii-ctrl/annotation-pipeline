import fs from 'node:fs';
import path from 'node:path';
import { identity, livingChildren } from './recovery.mjs';
import { DockerRuntime } from './docker-runtime.mjs';
import {
  localAPI,
  readJSON,
  saveJSON,
  ownedRunnerRoot,
} from './self-heal-io.mjs';

import { supersededObserver } from '../lib/observer-handoff.mjs';

// Only replace the observer process. Mac Terminal owns the actual Claude
// process and continues running; the existing sent receipt prevents replay.
export async function handoffTerminalObservers(
  root,
  pid,
  data,
  dependencies = {},
) {
  const getIdentity = dependencies.identity || identity;
  const ownerRoot = dependencies.ownedRunnerRoot || ownedRunnerRoot;
  const api = dependencies.localAPI || localAPI;
  const signal =
    dependencies.signal || ((pid, signal) => process.kill(pid, signal));
  const scheduler = data.runner?.scheduler;
  if (
    !scheduler?.draining ||
    scheduler.generating ||
    scheduler.recovering ||
    scheduler.finalizing
  )
    return false;
  const work = path.join(root, '.runner');
  const running = data.tasks.flatMap((task) =>
    task.turns
      .filter(
        (turn) =>
          turn.status === 'running' ||
          (turn.status === 'queued' &&
            supersededObserver(
              turn,
              readJSON(path.join(work, task.id, turn.id + '.job.json'))
                ?.jobToken,
            )),
      )
      .map((turn) => ({ task, turn })),
  );
  if (
    !running.length ||
    running.some(({ turn }) => turn.stage !== 'claude') ||
    scheduler.stages?.running?.some((s) => s.kind !== 'claude')
  )
    return false;
  const owner = getIdentity(pid),
    oldRoot = ownerRoot(root, pid);
  const runtime = dependencies.runtime || new DockerRuntime(work);
  const plans = [];
  for (const { task, turn } of running) {
    const journal = readJSON(path.join(work, task.id, turn.id + '.job.json'));
    const state = runtime.load(task.id),
      p = state?.pending;
    if (
      !journal?.jobToken ||
      journal.taskId !== task.id ||
      journal.turnId !== turn.id ||
      livingChildren(journal).length ||
      state?.questionId !== (turn.questionRootId || turn.id) ||
      p?.turnId !== turn.id ||
      p.phase !== 'sent' ||
      !p.count ||
      !/^[a-f0-9]{64}$/.test(p.promptHash || '') ||
      !state.terminal?.statePath
    )
      return false;
    const terminalFile = path.resolve(state.terminal.statePath);
    if (
      !terminalFile.startsWith(
        path.join(work, task.id, 'questions', state.questionId) + path.sep,
      )
    )
      return false;
    const terminal = readJSON(terminalFile);
    if (
      terminal?.status !== 'running' ||
      !terminal.realTerminal ||
      terminal.runId !== state.terminal.runId ||
      !getIdentity(terminal.pid) ||
      !getIdentity(terminal.childPid) ||
      !runtime.owned(state).State.Running
    )
      return false;
    plans.push({
      action: 'handoff-observer',
      taskId: task.id,
      turnId: turn.id,
      jobToken: journal.jobToken,
      containerId: state.containerId,
      sessionId: state.sessionId || null,
      terminalRunId: terminal.runId,
      promptHash: p.promptHash,
      terminalPid: terminal.pid,
      terminalIdentity: getIdentity(terminal.pid),
    });
  }
  if (getIdentity(pid) !== owner) return false;
  const file = path.join(work, 'self-heal/observer-handoff.json');
  saveJSON(file, {
    pid,
    owner,
    oldRoot,
    plans,
    state: 'intent',
    at: new Date().toISOString(),
  });
  const token =
    process.env.RUNNER_TOKEN ||
    fs
      .readFileSync(path.join(root, '.dev.vars'), 'utf8')
      .match(/^RUNNER_TOKEN=(.+)$/m)?.[1];
  if (!token) throw Error('观察交接缺少本机认证');
  for (const plan of plans)
    await api('/api/runner', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify(plan),
    });
  if (getIdentity(pid) !== owner)
    throw Error('旧观察器身份已变化，交接记录保留');
  // A stage could finish while the handoff request was in flight. Never kill
  // a newly started evaluator; the queued receipt still lets the old job exit.
  for (const plan of plans) {
    if (
      livingChildren(
        readJSON(path.join(work, plan.taskId, plan.turnId + '.job.json')) || {},
      ).length ||
      getIdentity(plan.terminalPid) !== plan.terminalIdentity
    )
      return false;
  }
  // SIGTERM detaches the observer sockets. It never signals Terminal or Docker.
  signal(pid, 'SIGTERM');
  saveJSON(file, {
    pid,
    owner,
    oldRoot,
    plans,
    state: 'observer-stopping',
    at: new Date().toISOString(),
  });
  return true;
}
