import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DockerRuntime, assertNativeSessionIdle } from './docker-runtime.mjs';
import { verifyNativeExport } from './evidence.mjs';
import { terminalProtocolVersion } from './mac-terminal.mjs';
import { createRunnerApi } from './runner-api.mjs';
import { queueFinalSubmission } from './final-submissions.mjs';

// Only an explicitly selected, completed server error with no tool calls can
// end here. This does not retry, exclude, score, or mark the failed turn passed.
export function assertFailedSessionCandidate(task, state, turnId, files) {
  const turn = task.turns?.at(-1);
  if (
    !turnId ||
    turn?.id !== turnId ||
    turn.status !== 'failed' ||
    turn.executionOutcome !== 'error' ||
    turn.recoveryBlocked ||
    task.turns.some((r) => ['queued', 'running'].includes(r.status)) ||
    state.taskId !== task.id ||
    state.status !== 'running' ||
    state.pending ||
    state.questionId !== turn.questionRootId ||
    state.containerId !== turn.container?.containerId ||
    state.sessionId !== turn.sessionId ||
    state.terminal?.terminalProtocolVersion !== terminalProtocolVersion
  )
    throw Error('当前题目不满足人工指定失败会话的收尾条件');
  const result = state.results?.[turnId];
  if (
    result?.success !== false ||
    result.executionOutcome !== 'error' ||
    result.promptId !== turn.promptId ||
    result.sessionId !== turn.sessionId ||
    result.permissionAudit?.passed !== true ||
    !task.turns.some(
      (r) =>
        r.questionRootId === state.questionId &&
        r.id !== turnId &&
        r.status === 'review' &&
        r.review &&
        r.automation?.archive,
    )
  )
    throw Error('失败回执或前序已完成评分不完整');
  const idle = assertNativeSessionIdle(state, files, { failedTurnId: turnId });
  if (!idle.completedPromptIds.includes(result.promptId))
    throw Error('原生末轮与指定失败轮次不一致');
  return {
    taskId: task.id,
    questionId: state.questionId,
    turnId,
    containerId: state.containerId,
    sessionId: state.sessionId,
    promptId: result.promptId,
    runId: state.terminal.runId,
  };
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      task: { type: 'string' },
      turn: { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  const taskId = args.task,
    turnId = args.turn;
  if (![taskId, turnId].every((id) => /^[a-f0-9-]{36}$/.test(id || '')))
    throw Error('需要明确的 --task 与 --turn');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workRoot = path.join(root, '.runner');
  const token = readFileSync(path.join(root, '.dev.vars'), 'utf8').match(
    /^RUNNER_TOKEN=(.+)$/m,
  )?.[1];
  if (!token) throw Error('本机执行器认证配置缺失');
  const api = createRunnerApi({ base: 'http://127.0.0.1:3000', token });
  const readTask = async () => {
    const response = await fetch('http://127.0.0.1:3000/api/tasks');
    if (!response.ok) throw Error('读取本机任务失败');
    const task = (await response.json()).tasks.find((t) => t.id === taskId);
    if (!task) throw Error('任务不存在');
    return task;
  };
  const runtime = new DockerRuntime(
    workRoot,
    (container) => api({ action: 'container', taskId, container }),
    () => false,
    undefined,
    undefined,
    (state) => queueFinalSubmission(workRoot, state),
  );
  const task = await readTask(),
    state = runtime.load(taskId);
  if (!state) throw Error('原容器状态不存在');
  const proof = assertFailedSessionCandidate(
    task,
    state,
    turnId,
    runtime.native(state),
  );
  const result = state.results[turnId];
  verifyNativeExport(result.traceExport, {
    dir: path.join(workRoot, taskId),
    containerId: state.containerId,
  });
  const sourceResult = readFileSync(
    path.join(workRoot, taskId, turnId + '.result.json'),
  );
  const saved = JSON.parse(sourceResult);
  if (
    saved.taskId !== taskId ||
    saved.turnId !== turnId ||
    saved.success !== false ||
    saved.promptId !== proof.promptId ||
    saved.sessionId !== proof.sessionId ||
    saved.traceExport?.sha256 !== result.traceExport.sha256
  )
    throw Error('持久化失败回执与原生身份不符');
  const current = await readTask();
  if (current.revision !== task.revision) throw Error('任务已变化，请重新核对');
  const stamp = {
    ...proof,
    verifiedAt: new Date().toISOString(),
    failedResultSha256: createHash('sha256').update(sourceResult).digest('hex'),
    traceSha256: result.traceExport.sha256,
    action: 'finalize-confirmed-server-error',
  };
  if (!args.apply) {
    console.log(JSON.stringify({ ready: true, ...stamp }));
    return;
  }
  const auditDir = path.join(workRoot, 'failed-session-finalization');
  mkdirSync(auditDir, { recursive: true });
  const receipt = path.join(auditDir, turnId + '.json');
  if (existsSync(receipt)) {
    const prior = JSON.parse(readFileSync(receipt, 'utf8'));
    if (
      Object.keys(stamp).some(
        (key) => key !== 'verifiedAt' && prior[key] !== stamp[key],
      )
    )
      throw Error('已有收尾核验记录与当前原件不符');
  } else
    writeFileSync(receipt, JSON.stringify(stamp, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  try {
    await runtime.close(taskId, {
      failedTurnId: turnId,
      beforeExit: async () => {
        const latest = await readTask();
        if (latest.revision !== task.revision)
          throw Error('任务在收尾期间发生变化，保留容器');
      },
    });
    const after = readFileSync(
      path.join(workRoot, taskId, turnId + '.result.json'),
    );
    if (!after.equals(sourceResult)) throw Error('原始失败回执发生变化');
    console.log(
      JSON.stringify({
        finalized: true,
        ...proof,
        failedResultPreserved: true,
        submissionQueued: true,
      }),
    );
  } finally {
    runtime.detach();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
