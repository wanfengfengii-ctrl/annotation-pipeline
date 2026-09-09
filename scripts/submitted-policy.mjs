import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { assertPolicyAudit, candidateDigest } from '../lib/task-policy.mjs';
import {
  auditPermissionTraces,
  permissionIssues,
} from '../lib/permission-audit.mjs';

export const submittedPolicyVersion = '2026-09-10.submitted-policy1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const timestamp = (value) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw Error('已发送题目证据缺少有效时间');
  return time;
};
// This is permission to finish collecting evidence only. It never reverses a
// rejection or approves the question, delivery, next question, or export.
export async function submittedPolicyEvidence({
  dir,
  turnId,
  cached,
  candidate,
}) {
  if (!cached.claude?.success) {
    if (cached.submittedPolicyEvidence)
      throw Error('既有已发送题目异议缺少成功原生结果，不能回退重新执行');
    return null;
  }
  if (!/^[a-f0-9-]{36}$/.test(turnId || '')) throw Error('已发送题目轮次无效');
  const root = realpathSync(dir);
  const file = (name) => {
    const resolved = path.resolve(name);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('已发送题目证据超出任务目录');
    let component = root;
    for (const part of relative.split(path.sep)) {
      component = path.join(component, part);
      if (lstatSync(component).isSymbolicLink())
        throw Error('已发送题目证据含符号链接');
    }
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
      throw Error('已发送题目证据不是有效普通文件');
    const bytes = readFileSync(resolved);
    return {
      path: resolved,
      sha256: hash(bytes),
      bytes,
      mtimeMs: stat.mtimeMs,
    };
  };
  const jsonFile = (name) => {
    const record = file(name);
    return { ...record, value: JSON.parse(record.bytes.toString('utf8')) };
  };
  const records = readdirSync(root)
    .filter(
      (name) =>
        name.startsWith(turnId + '.attempt-') && name.endsWith('.policy.json'),
    )
    .map((name) => {
      const match = name.match(/\.attempt-(\d+)\.policy\.json$/);
      if (!match) throw Error('已发送题目审核文件名无效');
      return { ...jsonFile(path.join(root, name)), attempt: Number(match[1]) };
    })
    .sort((a, b) => a.attempt - b.attempt);
  const finished = timestamp(cached.claude.finishedAt);
  const savedDispute = cached.submittedPolicyEvidence;
  const originalPolicy = savedDispute?.originalPolicy || cached.policy;
  const postRejected = (value) =>
    value?.allowed === false ||
    (!!originalPolicy?.questionRuleVersion &&
      value?.questionCompliant === false);
  // A failed draft predating execution is not a post-execution rejection.
  // A previously recorded dispute cannot disappear by touching/deleting files.
  if (
    !savedDispute &&
    !records.some((r) => r.mtimeMs >= finished && postRejected(r.value))
  )
    return null;

  const original = structuredClone(originalPolicy);
  if (original?.accepted !== true || original.engine !== 'codex-cli')
    throw Error('已发送题目缺少发送前已通过的审核证据');
  if (
    cached.claude.executionOutcome !== 'complete' ||
    permissionIssues(cached.claude).length
  )
    throw Error('已发送题目尚无完整成功且权限合格的原生结果');
  const prompt = cached.prepare?.value?.prompt;
  if (
    !prompt ||
    candidate?.prompt !== prompt ||
    candidate.category !== cached.prepare.value.category ||
    candidate.difficulty !== cached.prepare.value.difficulty ||
    candidate.difficulty !== original.value.assessedDifficulty
  )
    throw Error('已发送题目与准备记录或候选不一致');
  const digest = await candidateDigest(candidate);
  if (digest !== original.candidateDigest)
    throw Error('发送前审核候选摘要不匹配');
  assertPolicyAudit(structuredClone(original), digest, {
    firstTurn: original.roundContext?.firstTurn ?? true,
    allowFollowupFix: original.roundContext?.allowFollowupFix ?? false,
    requireQuestionStyle: !!original.questionRuleVersion,
  });

  const auditEvidence = (record, expectedThreadId) => {
    const trace = file(record.path.replace(/\.json$/, '.events.jsonl'));
    const events = trace.bytes
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const threadId = events.find(
      (event) => event.type === 'thread.started',
    )?.thread_id;
    const messages = events.filter(
      (event) =>
        event.type === 'item.completed' && event.item?.type === 'agent_message',
    );
    let final;
    try {
      final = JSON.parse(messages.at(-1)?.item?.text);
    } catch {
      throw Error('审核事件缺少完整结构化结论');
    }
    if (
      !threadId ||
      (expectedThreadId && threadId !== expectedThreadId) ||
      !events.some((event) => event.type === 'turn.completed') ||
      events.some((event) => event.type === 'turn.failed') ||
      !isDeepStrictEqual(final, record.value)
    )
      throw Error('审核输出与 Codex 事件证据不一致');
    return {
      attempt: record.attempt,
      value: record.value,
      engine: 'codex-cli',
      threadId,
      outputPath: record.path,
      outputSha256: record.sha256,
      tracePath: trace.path,
      traceSha256: trace.sha256,
    };
  };
  const originalPath = original.tracePath?.replace(/\.events\.jsonl$/, '.json');
  const originalRecord = records.find((record) => record.path === originalPath);
  if (
    !originalRecord ||
    !isDeepStrictEqual(originalRecord.value, original.value)
  )
    throw Error('发送前审核原文件与缓存不一致');
  const originalEvidence = auditEvidence(originalRecord, original.threadId);

  const exported = cached.claude.traceExport;
  const manifest = jsonFile(exported.manifestPath);
  if (
    !Array.isArray(manifest.value.files) ||
    !manifest.value.files.length ||
    hash(JSON.stringify(manifest.value.files)) !== exported.sha256 ||
    manifest.value.files.length !== exported.files ||
    manifest.value.containerId !== cached.claude.container?.containerId
  )
    throw Error('原生轨迹导出回执与 manifest 不一致');
  const nativeFiles = [];
  const names = new Set();
  for (const item of manifest.value.files) {
    if (
      typeof item.name !== 'string' ||
      names.has(item.name) ||
      path.isAbsolute(item.name) ||
      item.name.split(/[\\/]/).includes('..')
    )
      throw Error('原生轨迹 manifest 文件名无效');
    names.add(item.name);
    const native = file(path.join(exported.path, item.name));
    if (native.sha256 !== item.sha256 || native.bytes.length !== item.bytes)
      throw Error('原生轨迹文件摘要不一致');
    if (item.name.endsWith('.jsonl'))
      nativeFiles.push({
        name: item.name,
        content: native.bytes.toString('utf8'),
      });
  }
  if (!auditPermissionTraces(nativeFiles).passed)
    throw Error('原生完整会话权限核验未通过');
  const matches = [];
  for (const native of nativeFiles) {
    const events = native.content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    for (const [start, event] of events.entries()) {
      if (
        event.type !== 'user' ||
        event.isSidechain ||
        event.uuid !== cached.claude.promptId
      )
        continue;
      if (
        event.sessionId !== cached.claude.sessionId ||
        event.message?.content !== prompt
      )
        throw Error('原生用户题目或会话回执不匹配');
      let end = events.findIndex(
        (next, i) =>
          i > start &&
          next.type === 'user' &&
          typeof next.message?.content === 'string',
      );
      if (end < 0) end = events.length;
      const round = events.slice(start, end);
      const completed = round.find(
        (next) => next.type === 'system' && next.subtype === 'turn_duration',
      );
      if (
        !completed ||
        round.some(
          (next) => next.isApiErrorMessage || next.subtype === 'api_error',
        )
      )
        throw Error('原生本轮未完整结束或存在调用错误');
      matches.push({
        sentAt: event.timestamp,
        completedAt: completed.timestamp,
        content: round.map((next) => JSON.stringify(next)).join('\n') + '\n',
        nativeName: native.name,
      });
    }
  }
  if (matches.length !== 1) throw Error('原生题目回执缺失或不唯一');
  const native = matches[0];
  const sent = timestamp(native.sentAt);
  if (
    timestamp(original.finishedAt) >= sent ||
    timestamp(native.completedAt) < sent ||
    timestamp(native.completedAt) > finished
  )
    throw Error('审核、发送和原生完成时间顺序无效');
  const turnTrace = file(cached.claude.tracePath);
  if (
    turnTrace.path !== path.join(root, turnId + '.jsonl') ||
    turnTrace.bytes.toString('utf8') !== native.content
  )
    throw Error('本轮轨迹与原生完整导出不一致');
  const postExecutionPolicy = records
    .filter(
      (record) =>
        record.attempt > originalRecord.attempt && record.mtimeMs >= sent,
    )
    .map((record) => ({
      ...auditEvidence(record),
      disputed: postRejected(record.value),
    }));
  if (!postExecutionPolicy.some((record) => postRejected(record.value)))
    throw Error('已记录的后置审核拒绝证据缺失');
  if (savedDispute) {
    for (const previous of savedDispute.postExecutionPolicy || []) {
      const current = postExecutionPolicy.find(
        (record) => record.outputPath === previous.outputPath,
      );
      if (
        !current ||
        current.outputSha256 !== previous.outputSha256 ||
        current.traceSha256 !== previous.traceSha256
      )
        throw Error('既有后置审核证据发生变化');
    }
    if (
      savedDispute.receipt?.originalPolicyOutputSha256 !==
        originalEvidence.outputSha256 ||
      savedDispute.receipt?.originalPolicyTraceSha256 !==
        originalEvidence.traceSha256 ||
      savedDispute.receipt?.nativeManifestSha256 !== manifest.sha256 ||
      savedDispute.receipt?.turnTraceSha256 !== turnTrace.sha256
    )
      throw Error('既有已发送题目证据回执发生变化');
  }
  return {
    version: submittedPolicyVersion,
    originalPolicy: original,
    receipt: {
      purpose: '仅收集已发送题目的真实验收与评分证据，保留审核失败',
      taskId: path.basename(root),
      turnId,
      candidateDigest: digest,
      sessionId: cached.claude.sessionId,
      promptId: cached.claude.promptId,
      promptSha256: hash(prompt),
      sentAt: native.sentAt,
      completedAt: native.completedAt,
      originalPolicyOutputPath: originalEvidence.outputPath,
      originalPolicyOutputSha256: originalEvidence.outputSha256,
      originalPolicyTracePath: originalEvidence.tracePath,
      originalPolicyTraceSha256: originalEvidence.traceSha256,
      nativeManifestPath: manifest.path,
      nativeManifestSha256: manifest.sha256,
      nativeExportSha256: exported.sha256,
      turnTracePath: turnTrace.path,
      turnTraceSha256: turnTrace.sha256,
    },
    postExecutionPolicy,
  };
}

export function submittedPolicyInstructions(evidence) {
  if (!evidence) return '';
  const findings = evidence.postExecutionPolicy.filter(
    (record) => record.disputed === true,
  );
  return `本轮已发送且 Claude 原生交互已完整结束，但后置题目审核发现以下异议：${JSON.stringify(findings)}\n保持原题、原验收要求和原轨迹不变，按真实输入完成本轮独立验收及 AI 评分。明确区分出题方的事实错误与 Claude 对实际收到需求的响应，不把出题错误归因于 Claude；既有日志不支持的操作不能声称此前已经复现。当前验收应实际分别检查原题要求的交互和历史日志中真实执行的交互，陈述真实结果，不制造失败或成功。把审核异议及其对证据解释的影响写入 processFindings、artifactFindings 和交付校验结论；即使内部评测材料完整，本轮仍保留审核失败，禁止自动续题、生成合格交付包、归档或标准导出。`;
}

export function assertSubmittedPolicyDeliverable(evidence) {
  if (evidence)
    throw Error(
      '已发送题目存在后置审核异议；验收与 AI 评分证据已保留，本轮仍审核失败，禁止自动续题、归档或标准导出',
    );
}
