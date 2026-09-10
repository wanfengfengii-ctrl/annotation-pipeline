import fs from 'node:fs';
import path from 'node:path';
import { assertRecordSource } from '../lib/business-record.mjs';
import { isNativeUserMessage } from '../lib/native-user-message.mjs';
import { completedGateway504 } from './native-gateway-error.mjs';
import { resolveSoloNativeIdentity } from './solo-native-identity.mjs';
import { verifyNativeExport } from './evidence.mjs';
import { digest } from './solo-records.mjs';

export function verifyBusinessRecordNative({ task, row, dir, traceExport }) {
  const record = assertRecordSource(task, row);
  const { origin, result, chain } = record;
  const nativeIdentity = resolveSoloNativeIdentity({
    dir,
    traceExport,
    containerId: origin.container.containerId,
    sessionId: origin.sessionId,
    messageUuid: origin.promptId,
  });
  if (!record.recovery) return { nativeIdentity };
  if (
    result.executionOutcome !== 'complete' ||
    !['review', 'submitted'].includes(result.status) ||
    !result.review ||
    chain.some((r) => r.excluded || r.permissionAudit?.passed !== true) ||
    traceExport.sha256 !== record.recovery.finalTraceSha256
  )
    throw Error('504 原题尚未完成继续评分或最终轨迹核验');
  const native = verifyNativeExport(traceExport, {
    dir,
    containerId: origin.container.containerId,
  });
  const events = fs
    .readFileSync(path.join(native.root, nativeIdentity.file), 'utf8')
    .split('\n')
    .filter((v) => v.trim())
    .map((v) => JSON.parse(v));
  const prompts = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isNativeUserMessage(event));
  const steps = [];
  for (const [index, turn] of chain.entries()) {
    const matches = prompts
      .map((p, i) => ({ ...p, round: i + 1 }))
      .filter(
        ({ event }) =>
          event.uuid === turn.promptId && event.sessionId === origin.sessionId,
      );
    if (matches.length !== 1) throw Error('最终原生轨迹中缺少唯一恢复消息');
    const found = matches[0],
      step = record.recovery.steps[index];
    if (
      found.round !== step.round ||
      found.event.message.content !== turn.prompt ||
      !found.event.promptId ||
      (index > 0 &&
        (found.round !== steps[index - 1].round + 1 || turn.prompt !== '继续'))
    )
      throw Error('504 恢复消息的原文、实际轮次或相邻关系不符');
    const next = prompts[found.round];
    const roundEvents = events.slice(found.index, next?.index ?? events.length);
    if (index < chain.length - 1) {
      if (completedGateway504(roundEvents)?.eventSha256 !== step.eventSha256)
        throw Error('最终原生轨迹中无法核实前一轮已结束的 504');
    } else {
      const lastDuration = roundEvents.findLastIndex(
        (e) =>
          !e.isSidechain &&
          e.type === 'system' &&
          e.subtype === 'turn_duration',
      );
      const calls = new Set(),
        returned = new Set();
      for (const e of roundEvents.filter((e) => !e.isSidechain))
        for (const c of Array.isArray(e.message?.content)
          ? e.message.content
          : []) {
          if (c.type === 'tool_use') calls.add(c.id);
          if (c.type === 'tool_result') returned.add(c.tool_use_id);
        }
      if (
        lastDuration < 0 ||
        roundEvents.some(
          (e) =>
            !e.isSidechain &&
            (e.isApiErrorMessage || e.subtype === 'api_error'),
        ) ||
        roundEvents
          .slice(lastDuration + 1)
          .some(
            (e) =>
              !e.isSidechain &&
              (e.type === 'assistant' || isNativeUserMessage(e)),
          ) ||
        [...calls].some((id) => !returned.has(id)) ||
        [...returned].some((id) => !calls.has(id))
      )
        throw Error('最终继续轮未成功结束或存在未返回工具');
    }
    steps.push({ ...step, promptId: found.event.promptId });
  }
  const recoveryCoverage = {
    version: record.recovery.version,
    originTurnId: origin.id,
    resultTurnId: result.id,
    sessionId: origin.sessionId,
    containerId: origin.container.containerId,
    traceSha256: native.sha256,
    projectionSha256: digest(record.recovery),
    steps,
  };
  return { nativeIdentity, recoveryCoverage };
}
