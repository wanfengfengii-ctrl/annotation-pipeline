const pick = (value, keys) =>
  value
    ? Object.fromEntries(
        keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
      )
    : undefined;
const container = (c) =>
  c
    ? {
        ...pick(c, [
          'taskId',
          'questionId',
          'containerId',
          'status',
          'sessionId',
          'pending',
          'traceExport',
          'terminal',
          'terminalFinalization',
          'progress',
        ]),
      }
    : undefined;
export function monitorTask(t) {
  return {
    ...pick(t, [
      'id',
      'title',
      'projectName',
      'projectSeries',
      'closed',
      'revision',
      'repoPath',
      'category',
      'difficulty',
      'createdAt',
    ]),
    container: container(t.container),
    turns: t.turns.map((r) => ({
      ...pick(r, [
        'id',
        'category',
        'difficulty',
        'status',
        'stage',
        'startedAt',
        'finishedAt',
        'createdAt',
        'questionRootId',
        'promptId',
        'sessionId',
        'claudeAttempts',
        'executionOutcome',
        'excluded',
        'recoveryBlocked',
        'receipt',
        'repairOf',
        'continuationOf',
        'planRetry',
        'projectRetry',
        'projectSource',
        'stageRecovery',
        'traceExport',
        'gatewayFailure',
        'gatewayRecovery',
        'gatewayContinuation',
        'productionHistory',
      ]),
      error: r.error,
      // Only the protocol recovery word is needed to validate a 504 continuation.
      ...(r.gatewayContinuation && r.prompt === '继续'
        ? { prompt: '继续' }
        : {}),
      container: container(r.container),
      permissionAudit: pick(r.permissionAudit, ['passed']),
      humanReview: pick(r.humanReview, ['receipt']),
      review: pick(r.review, ['scores', 'source']),
      projectRecovery: pick(r.projectRecovery, [
        'version',
        'state',
        'turnId',
        'nextTurnId',
        'idleVerified',
        'reason',
        'attempts',
        'retryAt',
        'retryBudgets',
        'blockedOnInputs',
        'sourceSnapshot',
      ]),
      automation: {
        archive: r.automation?.archive,
        runtimeVerification: pick(r.automation?.runtimeVerification, [
          'status',
          'reportSha256',
          'executed',
        ]),
        runtimeRecovery: r.automation?.runtimeRecovery,
        next: r.automation?.next
          ? { value: { action: r.automation.next.value?.action } }
          : undefined,
        nextError: r.automation?.nextError,
        delivery: r.automation?.delivery
          ? {
              value: { passed: r.automation.delivery.value?.passed },
              finishedAt: r.automation.delivery.finishedAt,
            }
          : undefined,
        submission: r.automation?.submission
          ? { finalization: !!r.automation.submission.finalization }
          : undefined,
        projectContinuation: r.automation?.projectContinuation,
        submittedPolicyEvidence: r.automation?.submittedPolicyEvidence
          ? {
              receipt: pick(r.automation.submittedPolicyEvidence.receipt, [
                'sessionId',
                'promptId',
                'nativeExportSha256',
              ]),
              postExecutionPolicy:
                r.automation.submittedPolicyEvidence.postExecutionPolicy?.map(
                  (p) => ({ disputed: p.disputed }),
                ),
            }
          : undefined,
      },
    })),
  };
}
