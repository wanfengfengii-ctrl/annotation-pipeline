import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../../scripts/solo-records.mjs';
import { evidenceInventory } from '../../scripts/evidence.mjs';
import { completedGateway504 } from '../../scripts/native-gateway-error.mjs';
import { gatewayContinuationVersion as version } from '../../lib/gateway-continuation.mjs';
import { permissionAuditVersion } from '../../lib/permission-audit.mjs';
import { submissionPolicyVersion } from '../../lib/submission-policy.mjs';

export function gatewayRecordFixture(
  dir,
  { bug = false, continuations = 2 } = {},
) {
  const snapshot =
    'https://github.com/fixture/initial/commit/' + '1'.repeat(40);
  const container = {
    taskId: 'task',
    questionId: 'first',
    containerId: 'c'.repeat(64),
    status: 'running',
    terminalIdentity: {
      transport: 'mac-terminal',
      realTerminal: true,
      tty: '/dev/fixture',
      runId: 'first',
    },
  };
  const review = {
    source: 'codex',
    reviewer: 'Codex',
    scores: [4, 3, 4, 3, 4],
    descriptions: Array(5).fill('最终结果已按原目标核验'),
    other: '无',
  };
  const task = {
    id: 'task',
    title: '__GATEWAY_RECORD__',
    harnessVersion: '2.1',
    os: 'macOS',
    snapshot,
    initialCodeSnapshots: { first: { url: snapshot } },
    turns: [],
  };
  const events = [
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
  ];
  const add = (id, prompt, failed) => {
    const round = [
      {
        type: 'user',
        uuid: 'uuid-' + id,
        promptId: 'prompt-' + id,
        sessionId: 'session',
        message: { content: prompt },
      },
      failed
        ? {
            type: 'assistant',
            isApiErrorMessage: true,
            error: 'server_error',
            message: {
              content: [
                { type: 'text', text: 'API Error: 504 Gateway Time-out' },
              ],
            },
          }
        : {
            type: 'assistant',
            message: { content: [{ type: 'text', text: '已经完成' }] },
          },
      { type: 'system', subtype: 'turn_duration' },
    ];
    events.push(...round);
    const turn = {
      id,
      prompt,
      promptId: 'uuid-' + id,
      sessionId: 'session',
      questionRootId: 'first',
      category: bug && id !== 'first' ? 'Bug 修复' : '0-1 代码生成',
      difficulty: '困难',
      status: failed ? 'failed' : 'review',
      executionOutcome: failed ? 'error' : 'complete',
      createdAt: '2026-09-10T01:00:00.000Z',
      finishedAt: '2026-09-10T02:00:00.000Z',
      container: structuredClone(container),
      traceExport: { verified: true, sha256: digest(events) },
      tracePath: path.join(dir, id + '.jsonl'),
      permissionAudit: {
        version: permissionAuditVersion,
        passed: true,
        modeVerified: true,
        denialCount: 0,
        traceSha256: digest(events),
      },
      automation: {
        preparation: { value: { acceptance: ['原题要求'] } },
        policy: { accepted: true },
        delivery: { value: { passed: !failed } },
        bundlePath: path.join(dir, 'bundle.json'),
      },
      ...(failed ? {} : { review: structuredClone(review) }),
    };
    if (failed)
      turn.gatewayFailure = {
        version,
        ...completedGateway504(round),
        promptId: turn.promptId,
        sessionId: turn.sessionId,
        traceSha256: turn.traceExport.sha256,
      };
    task.turns.push(turn);
    return turn;
  };
  if (bug) add('first', '建立原来的功能', false);
  const origin = add(
    bug ? 'bug' : 'first',
    bug ? '修复筛选后页码回退的问题' : '增加完整的记录管理功能',
    true,
  );
  if (bug) origin.repairOf = 'first';
  let previous = origin;
  for (let n = 1; n <= continuations; n++) {
    const next = add('continue-' + n, '继续', n < continuations);
    next.continuationOf = previous.id;
    next.evaluationPrompt = origin.prompt;
    next.gatewayContinuation = {
      version,
      failedTurnId: previous.id,
      failedPromptId: previous.promptId,
      sessionId: 'session',
      containerId: container.containerId,
      traceSha256: previous.traceExport.sha256,
    };
    previous.gatewayRecovery = { version, nextTurnId: next.id };
    previous = next;
  }
  const result = previous;
  const root = path.join(dir, 'final', 'projects');
  fs.mkdirSync(root, { recursive: true });
  const main = path.join(root, 'session.jsonl');
  fs.writeFileSync(
    main,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const inventory = evidenceInventory(root);
  const manifestPath = path.join(dir, 'final', 'manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      containerId: container.containerId,
      files: inventory.files,
    }),
  );
  const traceExport = {
    verified: true,
    exportKind: 'final',
    commandTransport: 'original-mac-terminal',
    path: root,
    manifestPath,
    files: inventory.files.length,
    sha256: digest(inventory.files),
  };
  const finalization = {
    version: '2026-09-10.terminal-finalization1',
    taskId: 'task',
    questionId: 'first',
    containerId: container.containerId,
    runId: 'first',
    sessionId: 'session',
    status: 'removed',
    commandTransport: 'original-mac-terminal',
    traceExport,
    manifestSha256: 'd'.repeat(64),
    receiptSha256: 'e'.repeat(64),
    receiptPath: path.join(dir, 'finalization.json'),
    removedAt: '2026-09-10T03:00:00.000Z',
  };
  for (const turn of task.turns.filter((r) => r.review)) {
    turn.automation.archive = { sha256: 'f'.repeat(64) };
    turn.automation.submission = {
      version: submissionPolicyVersion,
      status: 'passed',
      finalization,
      traceExportSha256: traceExport.sha256,
      sourceArchiveSha256: 'f'.repeat(64),
      reviewRequiredFiles: [],
    };
  }
  return { task, origin, result, events, main, traceExport };
}
