import { businessRecord, businessRecordOrigins } from './business-record.mjs';
const hash = (v) => (/^[a-f0-9]{64}$/.test(v || '') ? v : null);
const artifact = (v, pathKey = 'path', hashKey = 'sha256') =>
  v ? { path: v[pathKey] || null, sha256: hash(v[hashKey]) } : null;
const review = (v) =>
  v
    ? {
        scores: v.scores || [],
        descriptions: v.descriptions || [],
        other: v.other || '',
        evidenceRefs: v.evidenceRefs || [],
      }
    : null;
// This projection is deliberately not an upload admission or a substitute for
// reading original evidence. Message UUID is never relabelled as PromptID.
export function deliveryIndex(
  task,
  input,
  { exports = [], uploads = {} } = {},
) {
  const { origin, result, chain } = businessRecord(task, input);
  const a = result.automation || {},
    upload = uploads[task.id + ':' + origin.id] || null;
  const initial =
    task.initialCodeSnapshots?.[origin.questionRootId || origin.id];
  const final = a.submission?.finalization;
  const members = new Set(chain.map((r) => r.id));
  const batches = new Set(
    exports.filter((e) => members.has(e.turnId)).map((e) => e.batchId),
  );
  const missing = [];
  if (!origin.sessionId) missing.push('缺少原生 SessionID');
  if (
    !(
      upload?.identity?.sessionId === origin.sessionId &&
      upload?.identity?.messageUuid === origin.promptId &&
      upload?.identity?.promptId
    )
  )
    missing.push('尚未同步已核验的原生 PromptID');
  if (!initial?.url) missing.push('缺少本题初始代码快照');
  if (!a.runtimeVerification?.reportSha256) missing.push('缺少独立验收报告');
  if (!final?.traceExport?.sha256) missing.push('等待最终原终端轨迹归档');
  if (!result.review) missing.push('评分尚未完成');
  const revisions = [];
  const score = a.score;
  if (score?.fieldPatch)
    revisions.push({
      kind: '字段修订',
      previous: review(score.fieldPatch.base),
      fields: score.fieldPatch.fields,
    });
  if (score?.clarityRepair)
    revisions.push({
      kind: '表达澄清',
      descriptions: score.clarityRepair.originalDescriptions,
      tracePath: score.clarityRepair.originalTracePath,
    });
  if (score?.citationRepair)
    revisions.push({
      kind: '引用定位',
      evidenceRefs: score.citationRepair.originalEvidenceRefs,
      tracePath: score.citationRepair.originalTracePath,
    });
  if (score?.consistencyRevision)
    revisions.push({
      kind: '独立证据复评',
      scores: score.consistencyRevision.originalScores,
      tracePaths: score.consistencyRevision.originalTracePaths,
    });
  return {
    schemaVersion: '2026-09-12.delivery-index1',
    taskId: task.id,
    turnId: origin.id,
    resultTurnId: result.id,
    projectName: task.projectName || '',
    title: task.title,
    prompt: origin.evaluationPrompt || origin.prompt,
    category: origin.category,
    difficulty: origin.difficulty,
    status: result.status,
    sessionId: origin.sessionId || null,
    messageUuid: origin.promptId || null,
    nativePromptId:
      upload?.identity?.sessionId === origin.sessionId &&
      upload.identity.messageUuid === origin.promptId
        ? upload.identity.promptId
        : null,
    chain: chain.map((r) => ({
      turnId: r.id,
      messageUuid: r.promptId || null,
      stage: r.stage || null,
      status: r.status,
      actualCalls: r.claudeAttempts?.length || (r.promptId ? 1 : 0),
    })),
    initial: initial
      ? {
          url: initial.url,
          sha: initial.sha,
          manifestSha256: initial.manifestSha256,
        }
      : null,
    product: a.runtimeVerification?.source
      ? {
          files: a.runtimeVerification.source.files || [],
          omitted: a.runtimeVerification.source.omitted || [],
        }
      : null,
    facts: artifact(a.reviewFacts),
    runtime: artifact(a.runtimeVerification, 'reportPath', 'reportSha256'),
    archive: artifact(a.archive, 'archivePath'),
    finalTrace: artifact(final?.traceExport),
    finalReceiptSha256: hash(final?.receiptSha256),
    score: review(result.review),
    scoreSource: result.review?.source || null,
    revisions,
    human: result.humanReview
      ? {
          state: result.humanReview.state,
          updatedAt: result.humanReview.updatedAt,
        }
      : null,
    exportCount: batches.size,
    upload,
    missing,
    runtimeRecovery: a.runtimeRecovery
      ? {
          state: a.runtimeRecovery.state,
          stage: a.runtimeRecovery.stage,
          completedIds: a.runtimeRecovery.completedIds || [],
          reason: a.runtimeRecovery.lastError,
        }
      : null,
  };
}
export function deliveryIndexes(task, context) {
  return businessRecordOrigins(task).map((turn) => {
    try {
      return deliveryIndex(task, turn, context);
    } catch (e) {
      return {
        taskId: task.id,
        turnId: turn.id,
        prompt: turn.prompt,
        missing: [e.message],
        invalid: true,
      };
    }
  });
}
