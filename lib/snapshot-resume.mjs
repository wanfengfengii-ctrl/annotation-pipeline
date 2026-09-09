// Initial code is frozen before the first send. A reconnect must verify the
// runtime identity while preserving that evidence, not compare Claude's output
// against the empty scaffold a second time.
export function resumeInitialSnapshot(snapshot, current, evidencePath) {
  const initial = snapshot?.environmentEvidence;
  if (
    snapshot?.engine !== 'codex-cli' ||
    snapshot.value?.ready !== true ||
    !snapshot.tracePath ||
    !snapshot.threadId ||
    !initial
  )
    throw Error(
      '已发送的题目缺少通过校验的初始快照，不能把当前产物重建为初始状态',
    );
  for (const field of [
    'taskId',
    'questionId',
    'containerId',
    'imageId',
    'snapshot',
    'workDir',
  ])
    if (
      typeof initial[field] !== 'string' ||
      !initial[field] ||
      initial[field] !== current?.[field]
    )
      throw Error(`恢复快照的 ${field} 与本题原始环境不一致`);
  if (
    !current.running ||
    !current.isolationVerified ||
    !current.permissionPreflight?.passed ||
    !current.terminalIdentity?.realTerminal ||
    !initial.terminalIdentity?.runId ||
    initial.terminalIdentity.runId !== current.terminalIdentity.runId ||
    !initial.mount?.source ||
    initial.mount.source !== current.mount?.source ||
    initial.mount.destination !== current.mount?.destination ||
    current.mount?.writable !== true
  )
    throw Error('恢复快照的容器、终端、挂载或权限核验未通过');
  return {
    ...snapshot,
    resumeChecks: [
      ...(snapshot.resumeChecks || []),
      {
        environmentEvidence: current,
        environmentEvidencePath: evidencePath,
        initialCodeRechecked: false,
        reason:
          '题目已发送，保留初始代码核验；当前代码是执行产物，仅复核运行环境身份',
      },
    ],
  };
}
