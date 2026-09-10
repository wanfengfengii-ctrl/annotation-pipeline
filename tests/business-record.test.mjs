import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unzipSync } from 'fflate';
import { gatewayRecordFixture } from './fixtures/gateway-record.mjs';
import {
  businessRecordOrigins,
  assertRecordSource,
} from '../lib/business-record.mjs';
import { recordRow, recordHeaders } from '../lib/record-fields.ts';
import { csv } from '../lib/pipeline.ts';
import { verifyBusinessRecordNative } from '../scripts/solo-business-record.mjs';
import { createSoloNativeAttachment } from '../scripts/solo-native-attachment.mjs';
import { sequenceIssues } from '../scripts/solo-ui-queue.mjs';
import {
  coveredRecordRounds,
  recordSourceDigest,
} from '../scripts/solo-records.mjs';
import { applyUploadHolds } from '../scripts/solo-upload-holds.mjs';

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, ...gatewayRecordFixture(dir, options) };
}
function nativeRow(f) {
  const row = recordRow(f.task, f.origin, 'ai');
  Object.assign(
    row,
    verifyBusinessRecordNative({
      task: f.task,
      row,
      dir: f.dir,
      traceExport: f.traceExport,
    }),
  );
  row.values[2] = row.nativeIdentity.promptId;
  return row;
}

test('原题身份、最终评分、完整原件归为一条，内部三次调用和失败记录保持不变', (t) => {
  const f = fixture(t),
    before = JSON.stringify(f.task),
    bytes = fs.readFileSync(f.main);
  const row = nativeRow(f);
  assert.equal(businessRecordOrigins(f.task).length, 1);
  assert.equal(row.turnId, f.origin.id);
  assert.equal(row.resultTurnId, f.result.id);
  assert.equal(row.values[0], f.origin.prompt);
  assert.equal(row.values[2], 'prompt-first');
  assert.equal(row.values[3], '第一轮');
  assert.deepEqual(row.values.slice(13, 15), [4, '最终结果已按原目标核验']);
  assert.equal(row.eligible, true, row.exportIssues?.join(';'));
  assert.equal(row.reviewEligible, true);
  assert.equal(row.originalFields.tracePath, f.traceExport.path);
  assert.deepEqual(coveredRecordRounds(row, recordHeaders), [1, 2, 3]);
  assert.equal(sequenceIssues([row], recordHeaders).size, 0);
  const attachment = createSoloNativeAttachment({
    dir: f.dir,
    turnId: row.turnId,
    traceExport: f.traceExport,
    containerId: f.origin.container.containerId,
    sessionId: 'session',
    promptId: row.nativeIdentity.promptId,
  });
  assert.ok(
    Buffer.from(unzipSync(attachment.bytes)['projects/session.jsonl']).equals(
      bytes,
    ),
  );
  const exported = csv([f.task]);
  assert.match(exported, /增加完整的记录管理功能/);
  assert.ok(!exported.includes('"继续"'));
  assert.equal(JSON.stringify(f.task), before);
  assert.equal(f.origin.status, 'failed');
  assert.equal(f.task.turns.length, 3);
});
test('Bug 的恢复只归到该 Bug；真实轮次缺口必须有原件证明，业务前序不能省略', (t) => {
  const f = fixture(t, { bug: true }),
    row = nativeRow(f);
  assert.equal(row.turnId, 'bug');
  assert.equal(row.values[2], 'prompt-bug');
  assert.equal(row.values[3], '第二轮');
  assert.equal(businessRecordOrigins(f.task).length, 2);
  const first = recordRow(f.task, f.task.turns[0], 'ai');
  first.values[2] = 'prompt-first';
  assert.equal(sequenceIssues([first, row], recordHeaders).size, 0);
  assert.ok(sequenceIssues([row], recordHeaders).size);
  const later = { ...first, turnId: 'later', values: [...first.values] };
  later.values[0] = '后续 Bug';
  later.values[2] = 'prompt-later';
  later.values[3] = '第五轮';
  assert.equal(sequenceIssues([first, row, later], recordHeaders).size, 0);
  const missing = { ...row, recoveryCoverage: undefined };
  assert.ok(sequenceIssues([first, missing, later], recordHeaders).size);
  const altered = structuredClone(row);
  altered.recoveryCoverage.steps[1].round = 9;
  assert.throws(() => coveredRecordRounds(altered, recordHeaders));
});
test('错链、跨会话、排除和未完成不得借用旧结果放行', (t) => {
  for (const mutate of [
    (f) => {
      f.result.continuationOf = 'first';
    },
    (f) => {
      f.result.sessionId = 'different';
    },
    (f) => {
      f.origin.gatewayFailure.eventSha256 = '0'.repeat(64);
    },
    (f) => {
      f.result.excluded = true;
    },
    (f) => {
      f.result.status = 'running';
    },
    (f) => {
      f.result.executionOutcome = 'error';
    },
    (f) => {
      f.origin.permissionAudit.passed = false;
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => nativeRow(f));
  }
});
test('同样的显示文字但结果或最终轨迹改变，旧批次和上传包摘要必须失效', (t) => {
  const f = fixture(t),
    row = nativeRow(f),
    before = recordSourceDigest(row);
  assertRecordSource(f.task, row);
  const changed = structuredClone(row);
  changed.recoveryCoverage.traceSha256 = '0'.repeat(64);
  assert.notEqual(recordSourceDigest(changed), before);
  f.result.automation.submission.finalization.traceExport.sha256 = '0'.repeat(
    64,
  );
  assert.throws(() => assertRecordSource(f.task, row));
});
test('任一恢复轮的禁传标记传播到原题', (t) => {
  const f = fixture(t),
    row = nativeRow(f),
    root = path.join(f.dir, 'holds');
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, 'upload-holds.json'),
    JSON.stringify({
      version: 1,
      entries: {
        ['task:' + f.result.id]: { blocked: true, reason: '保留核对' },
      },
    }),
  );
  assert.equal(applyUploadHolds([row], root)[0].eligible, false);
});

test('恢复评分必须沿用原题目标，无效孤立链仍可见且不能导出', (t) => {
  const f = fixture(t);
  f.result.automation.preparation.value.acceptance = ['另一道题'];
  assert.throws(() => nativeRow(f), /评分目标|验收/);
  const origins = businessRecordOrigins(f.task);
  assert.ok(origins.some((r) => r.id === f.result.id));
  assert.equal(recordRow(f.task, f.result, 'ai').eligible, false);
  assert.equal(recordRow(f.task, f.result, 'ai').reviewEligible, false);
  assert.doesNotThrow(() => csv([f.task]));
});

test('API 上传同样校验恢复覆盖和业务前序回执，重复执行不重复提交', async (t) => {
  const { syncRecords } = await import('../scripts/solo-sync.mjs');
  const { soloNativeAttachmentVersion } =
    await import('../scripts/solo-native-attachment.mjs');
  const { digest } = await import('../scripts/solo-records.mjs');
  const f = fixture(t),
    first = nativeRow(f);
  const later = {
    ...recordRow(f.task, f.origin, 'ai'),
    turnId: 'later',
    resultTurnId: undefined,
    recovery: undefined,
    values: [...first.values],
  };
  later.values[0] = '后续业务题';
  later.values[2] = 'prompt-later';
  later.values[3] = '第四轮';
  const schema = {
    fingerprint: 'fixture',
    fields: [
      { field_key: 'user_prompt', is_required: true },
      { field_key: 'session_id', is_required: true },
      { field_key: 'turn_id', is_required: true },
      { field_key: 'round_no', is_required: true },
      { field_key: 'trace_file', is_required: true, field_type: 'attachment' },
    ],
  };
  const remote = [],
    ledger = {},
    requests = [];
  const client = {
    list: async () => ({ items: remote, meta: { total: remote.length } }),
    detail: async (id) => remote.find((r) => r.id === id),
    upload: async (file) => {
      requests.push('upload');
      return {
        name: file.name,
        path: 'fixture/native.zip',
        size: file.bytes.length,
      };
    },
    create: async (payload) => {
      requests.push('create');
      const row = {
        id: remote.length + 1,
        status: 'SUBMITTED',
        ...payload.data,
      };
      remote.push(row);
      return row;
    },
  };
  const bytes = Buffer.from('synthetic verified zip');
  const args = {
    client,
    ledger,
    rows: [first, later],
    headers: recordHeaders,
    schema,
    save: () => {},
    currentRow: async (row) => args.rows.find((r) => r.turnId === row.turnId),
    prepareAttachment: async () => ({
      bytes,
      name: 'native.zip',
      sha256: digest(bytes),
      status: 'passed',
      policyVersion: soloNativeAttachmentVersion,
      byteIdentical: true,
    }),
  };
  await syncRecords(args);
  assert.equal(remote.length, 2);
  assert.equal(remote[0].turn_id, 'prompt-first');
  assert.equal(remote[1].round_no, '第四轮');
  await syncRecords(args);
  assert.equal(remote.length, 2);
  assert.equal(requests.filter((r) => r === 'create').length, 2);
  const other = structuredClone(later);
  other.turnId = 'future';
  other.values[2] = 'prompt-future';
  other.values[3] = '第五轮';
  args.rows.push(other);
  ledger.entries['task:first'].sourceDigest = 'stale';
  const result = await syncRecords(args);
  assert.equal(remote.length, 2);
  assert.ok(result.blocked > 0);
});
