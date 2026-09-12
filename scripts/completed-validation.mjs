import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runtimeRetryContext } from './runtime-retry-context.mjs';
import { verifyNativeExport } from './evidence.mjs';
import { readNativeTurn } from './docker-runtime.mjs';

// A removed original container is historical evidence, never a live environment.
// Only a completed native result AND the exact source of an authenticated
// runtime report permit independent verification to resume without that container.
export function completedValidationEvidence({
  task,
  turn,
  cached,
  state,
  dir,
  stopped = false,
}) {
  const c = cached.claude,
    snapshot = cached.snapshot,
    initial = snapshot?.environmentEvidence;
  if (
    (stopped ? !c?.stoppedCompletion : !turn.stageRecovery?.validationOnly) ||
    state?.status !== (stopped ? 'stopped' : 'removed') ||
    state.pending ||
    !c?.success ||
    c.executionOutcome !== 'complete' ||
    !c.permissionAudit?.passed ||
    state.taskId !== task.id ||
    state.questionId !== turn.questionRootId ||
    state.containerId !== c.container?.containerId ||
    (!stopped &&
      (c.promptId !== turn.promptId || c.sessionId !== turn.sessionId)) ||
    !initial ||
    snapshot.value?.ready !== true ||
    snapshot.engine !== 'codex-cli'
  )
    throw Error('已归档题目缺少可核验的完成回执，不能重启原会话');
  for (const key of [
    'taskId',
    'questionId',
    'containerId',
    'imageId',
    'snapshot',
    'workDir',
  ])
    if (initial[key] !== state[key])
      throw Error('历史环境与完成回执身份不符：' + key);
  const exported = verifyNativeExport(c.traceExport, {
    dir,
    containerId: state.containerId,
  });
  const nativeContent = readFileSync(
    path.join(dir, turn.id + '.native.jsonl'),
    'utf8',
  );
  if (
    !exported.files.some(
      (file) =>
        file.name.endsWith('/' + c.sessionId + '.jsonl') &&
        file.sha256 ===
          createHash('sha256').update(nativeContent).digest('hex'),
    )
  )
    throw Error('原生完成记录与验真导出原件不一致');
  const otherIds = nativeContent
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === 'user' && event.uuid !== c.promptId)
    .map((event) => event.uuid);
  const native = readNativeTurn(
    [{ content: nativeContent }],
    cached.prepare.value.prompt,
    otherIds,
  );
  if (
    !native?.complete ||
    native.error ||
    native.promptId !== c.promptId ||
    native.sessionId !== c.sessionId
  )
    throw Error('原生完成记录不匹配');
  if (stopped)
    return {
      source: '已停止容器的原生完成记录；保留原环境快照，在独立验收容器验证',
      historical: true,
      running: false,
      initialEnvironmentEvidence: initial,
      nativeExportSha256: c.traceExport.sha256,
    };
  const report = cached.runtimeVerification;
  const feedback = runtimeRetryContext(
    report,
    {
      taskId: task.id,
      turnId: turn.id,
      dir,
      workDir: c.workDir,
      imageId: c.container.imageId,
      prompt: turn.evaluationPrompt || cached.prepare.value.prompt,
      acceptance: cached.prepare.value.acceptance,
      regressionContext: report?.regressionContext || null,
    },
    { allowCompleted: true },
  );
  if (!feedback)
    throw Error('已归档产物与原验收源码或日志不一致，不能恢复评分');
  return {
    source: '已归档的原始运行环境；本次仅在独立验收容器验证',
    historical: true,
    running: false,
    initialEnvironmentEvidence: initial,
    sourceReportPath: feedback.reportPath,
    sourceReportSha256: feedback.reportSha256,
  };
}

// Use only the archived question's own source and container record. The adapter
// exposes no Terminal, Docker control or state publication methods. Current
// project state and later turns remain outside the historical evaluator.
export function historicalValidationContext(task, turn, dir, liveContainers) {
  if (!turn.stageRecovery?.historical || !turn.stageRecovery.validationOnly)
    throw Error('缺少历史验收恢复标记');
  const index = task.turns.findIndex((r) => r.id === turn.id);
  if (
    index < 0 ||
    index === task.turns.length - 1 ||
    !/^[\w-]+$/.test(turn.questionRootId || '')
  )
    throw Error('历史验收题目身份不符');
  const state = JSON.parse(
    readFileSync(
      path.join(dir, 'container-' + turn.questionRootId + '.json'),
      'utf8',
    ),
  );
  if (
    state.status !== 'removed' ||
    state.pending ||
    state.taskId !== task.id ||
    state.questionId !== turn.questionRootId ||
    state.containerId !== turn.container?.containerId
  )
    throw Error('历史题目尚未归档或原容器身份不符');
  const containers = Object.freeze({
    load(id) {
      if (id !== task.id) throw Error('历史验收不能读取其他项目');
      return structuredClone(state);
    },
    public(value) {
      return liveContainers.public(value);
    },
  });
  return {
    containers,
    task: {
      ...task,
      turns: task.turns.slice(0, index + 1),
      container: containers.public(state),
      workDir: state.workDir,
      snapshot: state.snapshot,
      sessionId: turn.sessionId,
      harness: turn.harness || task.harness,
      harnessVersion: turn.harnessVersion || task.harnessVersion,
      model: turn.model || task.model,
      os: turn.os || task.os,
    },
  };
}
