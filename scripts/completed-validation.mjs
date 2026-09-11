import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runtimeRetryContext } from './runtime-retry-context.mjs';
import { verifyNativeExport } from './evidence.mjs';
import { readNativeTurn } from './docker-runtime.mjs';

// A removed original container is historical evidence, never a live environment.
// Only a completed native result AND the exact source of an authenticated blocked
// runtime report permit independent verification to resume without that container.
export function completedValidationEvidence({
  task,
  turn,
  cached,
  state,
  dir,
}) {
  const c = cached.claude,
    snapshot = cached.snapshot,
    initial = snapshot?.environmentEvidence;
  if (
    !turn.stageRecovery?.validationOnly ||
    state?.status !== 'removed' ||
    state.pending ||
    !c?.success ||
    c.executionOutcome !== 'complete' ||
    !c.permissionAudit?.passed ||
    state.taskId !== task.id ||
    state.questionId !== turn.questionRootId ||
    state.containerId !== c.container?.containerId ||
    c.promptId !== turn.promptId ||
    c.sessionId !== turn.sessionId ||
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
  const report = cached.runtimeVerification;
  const feedback = runtimeRetryContext(report, {
    taskId: task.id,
    turnId: turn.id,
    dir,
    workDir: c.workDir,
    imageId: c.container.imageId,
    prompt: turn.evaluationPrompt || cached.prepare.value.prompt,
    acceptance: cached.prepare.value.acceptance,
    regressionContext: report?.regressionContext || null,
  });
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
