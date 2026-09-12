import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyTerminalFinalization } from './terminal-finalization.mjs';
import { sanitizeSensitiveText } from '../lib/sensitive-content.mjs';
import {
  createSubmissionPackage,
  verifySubmissionPackage,
} from './submission-package.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const version = '2026-09-10.final-submission-queue1';
const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function save(file, value) {
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
export function queueFinalSubmission(workRoot, state) {
  if (
    !uuid(state.taskId) ||
    !uuid(state.questionId) ||
    state.status !== 'removed'
  )
    throw Error('最终提交队列的题目身份无效');
  const directory = path.join(workRoot, 'final-submissions');
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    state.taskId + '.' + state.questionId + '.json',
  );
  if (!existsSync(file))
    save(file, {
      version,
      taskId: state.taskId,
      questionId: state.questionId,
      turnIds: Object.keys(state.results || {}),
      createdAt: new Date().toISOString(),
    });
}

// A failed old result may have had its original finalization queue completed
// before scoring existed. Keep that receipt and enqueue this recovered archive
// separately; the original Terminal export is verified by the existing consumer.
export function queueRecoveredFinalSubmission(
  workRoot,
  state,
  turnId,
  archiveSha256,
) {
  if (
    !uuid(state.taskId) ||
    !uuid(state.questionId) ||
    !uuid(turnId) ||
    state.status !== 'removed' ||
    !state.results?.[turnId]?.success ||
    !/^[a-f0-9]{64}$/.test(archiveSha256 || '')
  )
    throw Error('历史验收最终提交队列身份无效');
  const directory = path.join(workRoot, 'final-submissions');
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    `${state.taskId}.${state.questionId}.validation.${turnId}.${archiveSha256}.json`,
  );
  if (!existsSync(file))
    save(file, {
      version,
      taskId: state.taskId,
      questionId: state.questionId,
      turnIds: [turnId],
      sourceArchiveSha256: archiveSha256,
      createdAt: new Date().toISOString(),
    });
}

// Replanning has its own finish message, with no assessment fields. The
// preserved evaluation is still the source of the original submission.
function submissionResult(dir, turnId) {
  const file = path.join(dir, turnId + '.result.json');
  if (!existsSync(file)) throw Error('评分结果尚未保存');
  const result = JSON.parse(readFileSync(file, 'utf8'));
  if (
    result.projectRecovery &&
    (!result.automation?.archive || !result.review)
  ) {
    const original = path.join(dir, turnId + '.pre-replan-result.json');
    if (existsSync(original)) return JSON.parse(readFileSync(original, 'utf8'));
  }
  return result;
}

function delivered(receiptPath) {
  return (
    existsSync(receiptPath) &&
    existsSync(receiptPath + '.delivered') &&
    readFileSync(receiptPath + '.delivered', 'utf8') ===
      hash(readFileSync(receiptPath))
  );
}

// Older consumers marked an unscored replan message done. Completion of that
// scan is not an acknowledgement of the assessment's submission receipt.
function hasPendingAssessment(dir, item) {
  return item.turnIds.some((turnId) => {
    if (!existsSync(path.join(dir, turnId + '.result.json'))) return false;
    const result = submissionResult(dir, turnId);
    return (
      result.automation?.archive &&
      result.review &&
      !delivered(path.join(dir, turnId + '.final-submission.json'))
    );
  });
}

// This durable queue outlives container replacement. Only submission metadata
// is delivered separately; original result and assessment receipts stay intact.
export async function flushFinalSubmissions({
  workRoot,
  api,
  knownSecrets = [],
  onError = () => {},
  createPackage = createSubmissionPackage,
  verifyPackage = verifySubmissionPackage,
  queueNames,
}) {
  const directory = path.join(workRoot, 'final-submissions');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter((name) =>
    name.endsWith('.json'),
  )) {
    if (queueNames && !queueNames.includes(name)) continue;
    const file = path.join(directory, name);
    let retry = {};
    try {
      retry = JSON.parse(readFileSync(file + '.retry', 'utf8'));
    } catch {}
    if (retry.nextAt > Date.now()) continue;
    try {
      const item = JSON.parse(readFileSync(file, 'utf8'));
      if (
        item.version !== version ||
        !uuid(item.taskId) ||
        !uuid(item.questionId) ||
        !Array.isArray(item.turnIds) ||
        item.turnIds.some((id) => !uuid(id))
      )
        throw Error('最终提交队列身份无效');
      const dir = path.join(workRoot, item.taskId);
      if (existsSync(file + '.done') && !hasPendingAssessment(dir, item))
        continue;
      const terminal = JSON.parse(
        readFileSync(
          path.join(dir, 'questions', item.questionId, 'terminal/launch.json'),
          'utf8',
        ),
      );
      const finalization = verifyTerminalFinalization({
        taskDir: dir,
        questionId: item.questionId,
        terminal,
      });
      if (!finalization) throw Error('最终原生导出尚未通过核验');
      for (const turnId of item.turnIds) {
        const result = submissionResult(dir, turnId);
        const archive = result.automation?.archive;
        if (!archive || !result.review) continue;
        if (
          result.taskId !== item.taskId ||
          result.turnId !== turnId ||
          result.container?.containerId !== finalization.containerId
        )
          throw Error('提交副本与本轮评分身份不符');
        const receiptPath = path.join(dir, turnId + '.final-submission.json');
        let request;
        if (existsSync(receiptPath)) {
          request = JSON.parse(readFileSync(receiptPath, 'utf8'));
          if (
            request.sourceArchiveSha256 !== archive.sha256 ||
            request.submission?.finalization?.receiptSha256 !==
              finalization.receiptSha256
          )
            throw Error('已有最终提交回执与原件不符');
        } else {
          const submission = createPackage({
            dir,
            turnId,
            archive,
            traceExport: finalization.traceExport,
            finalization,
            knownSecrets:
              typeof knownSecrets === 'function'
                ? knownSecrets(result.jobToken)
                : knownSecrets,
          });
          request = {
            action: 'submission-package',
            taskId: item.taskId,
            turnId,
            sourceArchiveSha256: archive.sha256,
            submission,
          };
          save(receiptPath, request);
        }
        const digest = hash(readFileSync(receiptPath));
        if (
          existsSync(receiptPath + '.delivered') &&
          readFileSync(receiptPath + '.delivered', 'utf8') === digest
        )
          continue;
        if (request.submission.status === 'passed')
          verifyPackage(request.submission, {
            dir,
            sourceArchive: archive,
            traceExport: finalization.traceExport,
            knownSecrets:
              typeof knownSecrets === 'function'
                ? knownSecrets(result.jobToken)
                : knownSecrets,
          });
        await api(request);
        writeFileSync(receiptPath + '.delivered', digest, { mode: 0o600 });
      }
      if (!existsSync(file + '.done'))
        writeFileSync(file + '.done', new Date().toISOString(), {
          mode: 0o600,
        });
    } catch (error) {
      // A failed submission copy retries independently of project execution.
      const attempts = (retry.attempts || 0) + 1;
      save(file + '.retry', {
        attempts,
        nextAt:
          Date.now() + Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4)),
      });
      onError({
        queue: name,
        reason:
          '最终提交副本待重试，原始结果保留：' +
          sanitizeSensitiveText(String(error.message || '核验未完成')).text,
      });
    }
  }
}
