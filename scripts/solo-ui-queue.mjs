// Browser transport uses the user's existing SOLO sign-in. It does not extract
// browser cookies or require storing the account password for scheduled runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { records, attachment } from './solo-upload.mjs';
import { digest, recordKey, parseRound } from './solo-records.mjs';
import { savePrivateJSON, SOLO_ORIGIN } from './solo-client.mjs';
import { withSoloLock } from './solo-lock.mjs';
import {
  blockUpload,
  uploadHolds,
  assertUploadNotHeld,
} from './solo-upload-holds.mjs';

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const root = path.join(project, '.runner', 'solo-upload');
const statePath = path.join(root, 'ui-state.json');
const packetRoot = path.join(root, 'packets');
const expectedAccount = '牛宇航'; // Observed signed-in account on the target site.
const state = () => {
  const ledger = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { version: 1, origin: SOLO_ORIGIN, expectedAccount, entries: {} };
  if (
    ledger.origin !== SOLO_ORIGIN ||
    ledger.expectedAccount !== expectedAccount
  )
    throw Error('SOLO 台账目标或账号不符');
  return ledger;
};
const locked = (run) => withSoloLock(path.join(root, 'journal.lock'), run);
const write = (value) => savePrivateJSON(statePath, value);

function packetPath(key) {
  if (!/^[\w-]+:[\w-]+$/.test(key)) throw Error('本地记录标识无效');
  return path.join(packetRoot, key.replace(':', '_') + '.json');
}

export function validateReceipt(packet, receipt) {
  if (
    !/^\d+$/.test(String(receipt.remoteId)) ||
    Number(receipt.remoteId) < 1 ||
    !['SUBMITTED', 'QC_PASSED', 'PENDING_FIX', 'DISCARDED'].includes(
      receipt.remoteStatus,
    ) ||
    receipt.sessionId !== packet.fields.SessionID ||
    receipt.promptId !== packet.fields['TurnID/PromptID'] ||
    receipt.fieldsVerified !== true ||
    receipt.account !== expectedAccount
  )
    throw Error('远端回执必须经页面核对账号、记录编号、原生标识和全部提交字段');
}

export function sequenceIssues(rows, headers) {
  const field = (row, label) => row.values[headers.indexOf(label)];
  const issues = new Map(),
    sessions = new Map();
  for (const row of rows.filter((r) => r.eligible)) {
    const id = field(row, 'SessionID');
    if (!sessions.has(id)) sessions.set(id, []);
    sessions.get(id).push(row);
  }
  for (const group of sessions.values()) {
    const roundRows = new Map();
    for (const row of group) {
      let round;
      try {
        round = parseRound(field(row, '当前对话轮次排序'));
      } catch {
        issues.set(recordKey(row), '对话轮次无效');
        continue;
      }
      if (roundRows.has(round)) {
        issues.set(recordKey(row), '同一会话出现重复轮次');
        issues.set(recordKey(roundRows.get(round)), '同一会话出现重复轮次');
      }
      roundRows.set(round, row);
    }
    const first = roundRows.get(1);
    const consistency = [
      '初始环境快照',
      'Harness',
      'Harness 版本',
      '操作系统',
      '环境可复现等级',
    ];
    for (const [round, row] of roundRows) {
      if (!first || field(first, '任务难度') === '简单') {
        issues.set(recordKey(row), '会话缺少可提交的中等及以上难度首轮');
        continue;
      }
      if (
        consistency.some(
          (label) =>
            headers.includes(label) &&
            field(first, label) !== field(row, label),
        )
      )
        issues.set(recordKey(row), '同一会话的初始快照或运行环境字段不一致');
      for (let previous = 1; previous < round; previous++)
        if (
          !roundRows.has(previous) ||
          issues.has(recordKey(roundRows.get(previous)))
        )
          issues.set(
            recordKey(row),
            '前序轮次缺失或不符合提交条件，保留原轮次待核对',
          );
    }
  }
  return issues;
}

export const prepareUI = () => locked(prepareUnlocked);
export const markSending = (key) => locked(() => markSendingUnlocked(key));
export const recordReceipt = (key, receipt) =>
  locked(() => recordReceiptUnlocked(key, receipt));

async function prepareUnlocked() {
  const source = await records(),
    ledger = state(),
    packets = [],
    blocked = [];
  const sessionIndex = source.headers.indexOf('SessionID'),
    roundIndex = source.headers.indexOf('当前对话轮次排序');
  source.rows.sort(
    (a, b) =>
      String(a.values[sessionIndex]).localeCompare(
        String(b.values[sessionIndex]),
      ) || parseRound(a.values[roundIndex]) - parseRound(b.values[roundIndex]),
  );
  const sequence = sequenceIssues(source.rows, source.headers);
  for (const row of source.rows) {
    if (row.uploadHold) {
      blocked.push({
        key: recordKey(row),
        reason: '用户已标记禁止上传 SOLO：' + row.uploadHold.reason,
      });
      continue;
    }
    if (row.nativeIdIssue) {
      blocked.push({ key: recordKey(row), reason: row.nativeIdIssue });
      continue;
    }
    if (!row.eligible) continue;
    const key = recordKey(row),
      old = ledger.entries[key],
      sourceDigest = digest(row.values);
    if (old?.remoteId) {
      if (old.sourceDigest !== sourceDigest)
        blocked.push({
          key,
          reason: '本地内容变更，保留已提交的远端记录待核对',
        });
      continue;
    }
    if (old?.state === 'submitting' || old?.state === 'uncertain') {
      packets.push({
        key,
        state: 'uncertain',
        packetPath: packetPath(key),
        reason: '仅在我的提交中核对，不得重新点击提交',
      });
      continue;
    }
    if (sequence.has(key)) {
      blocked.push({ key, reason: sequence.get(key) });
      continue;
    }
    try {
      const archive = await attachment(row, { attachment_max_mb: 20 });
      const fields = Object.fromEntries(
        source.headers.map((h, i) => [h, row.values[i]]),
      );
      fields['当前对话轮次排序'] = parseRound(fields['当前对话轮次排序']);
      // Administrative fields are left to SOLO; the source is explicitly AI.
      for (const key of [
        '轨迹文件',
        '提交人',
        '提交时间',
        '质检结果',
        '父记录',
        '审核备注',
        '父记录 2',
      ])
        delete fields[key];
      const packet = {
        version: 1,
        key,
        taskId: row.taskId,
        turnId: row.turnId,
        source: 'ai',
        provenance: row.provenance,
        nativeIdentity: row.nativeIdentity,
        expectedAccount,
        sourceDigest,
        fields,
        attachment: {
          path: archive.path,
          name: archive.name,
          sha256: archive.sha256,
          bytes: archive.bytes.length,
        },
        preparedAt: new Date().toISOString(),
      };
      packet.digest = digest({
        sourceDigest,
        fields,
        attachment: packet.attachment,
      });
      savePrivateJSON(packetPath(key), packet);
      ledger.entries[key] = {
        ...old,
        taskId: row.taskId,
        turnId: row.turnId,
        state: 'prepared',
        sourceDigest,
        packetDigest: packet.digest,
        updatedAt: packet.preparedAt,
      };
      packets.push({
        key,
        state: 'prepared',
        packetPath: packetPath(key),
        sessionId: fields.SessionID,
        promptId: fields['TurnID/PromptID'],
        round: fields['当前对话轮次排序'],
      });
    } catch (e) {
      blocked.push({ key, reason: e.message });
    }
  }
  ledger.lastPreparedAt = new Date().toISOString();
  ledger.lastPlan = {
    pending: packets.length,
    blocked,
    excluded: source.rows.filter((r) => !r.eligible).length,
  };
  write(ledger);
  return {
    expectedAccount,
    origin: SOLO_ORIGIN,
    packets,
    blocked,
    excluded: ledger.lastPlan.excluded,
  };
}

async function markSendingUnlocked(key) {
  const ledger = state(),
    p = JSON.parse(fs.readFileSync(packetPath(key), 'utf8')),
    entry = ledger.entries[key];
  assertUploadNotHeld(p);
  if (entry?.remoteId || entry?.state !== 'prepared')
    throw Error('本记录已有提交结果或存在不明确提交，不能重复发送');
  if (
    p.digest !== entry.packetDigest ||
    digest({
      sourceDigest: p.sourceDigest,
      fields: p.fields,
      attachment: p.attachment,
    }) !== p.digest
  )
    throw Error('提交包字段被更改');
  const current = await records(p.taskId);
  const row = current.rows.find((r) => r.turnId === p.turnId);
  if (!row?.eligible || digest(row.values) !== p.sourceDigest)
    throw Error('记录在提交前变化或已不符合交付条件');
  const sequence = sequenceIssues(current.rows, current.headers);
  if (sequence.has(key)) throw Error(sequence.get(key));
  const archive = await attachment(row, { attachment_max_mb: 20 });
  if (archive.sha256 !== p.attachment.sha256)
    throw Error('附件在填写后发生变化');
  entry.state = 'submitting';
  entry.submittingAt = new Date().toISOString();
  write(ledger);
  return { key, state: entry.state, packetDigest: p.digest };
}

function recordReceiptUnlocked(key, receipt) {
  const ledger = state(),
    p = JSON.parse(fs.readFileSync(packetPath(key), 'utf8')),
    entry = ledger.entries[key];
  validateReceipt(p, receipt);
  if (
    !entry ||
    (entry.remoteId && String(entry.remoteId) !== String(receipt.remoteId))
  )
    throw Error('远端回执与原台账冲突');
  Object.assign(entry, {
    state: 'submitted',
    remoteId: receipt.remoteId,
    remoteStatus: receipt.remoteStatus,
    receiptVerified: true,
    remoteReason:
      typeof receipt.reason === 'string' ? receipt.reason : entry.remoteReason,
    remoteUrl: SOLO_ORIGIN + '/app/submissions/' + receipt.remoteId,
    updatedAt: new Date().toISOString(),
  });
  write(ledger);
  return {
    key,
    remoteId: entry.remoteId,
    remoteStatus: entry.remoteStatus,
    receiptVerified: true,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [action, key, receiptPath] = process.argv.slice(2);
  Promise.resolve()
    .then(() => {
      if (action === '--prepare') return prepareUI();
      if (action === '--mark-sending') return markSending(key);
      if (action === '--receipt')
        return recordReceipt(
          key,
          JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
        );
      if (action === '--block') return blockUpload(key, receiptPath);
      if (action === '--status')
        return { ...state(), uploadHolds: uploadHolds().entries };
      throw Error(
        '用法：--prepare | --mark-sending taskId:turnId | --receipt taskId:turnId receipt.json | --block taskId:turnId 原因 | --status',
      );
    })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
