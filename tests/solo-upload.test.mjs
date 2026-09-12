import test from 'node:test';
import assert from 'node:assert/strict';
import { SoloClient, SoloError, SOLO_ORIGIN } from '../scripts/solo-client.mjs';
import {
  mapRecord,
  digest,
  sameRemote,
  findRemote,
} from '../scripts/solo-records.mjs';
import { syncRecords } from '../scripts/solo-sync.mjs';
import { soloNativeAttachmentVersion } from '../scripts/solo-native-attachment.mjs';

const headers = [
  'User Prompt',
  'SessionID',
  'TurnID/PromptID',
  '当前对话轮次排序',
  '初始环境快照',
  '轨迹文件',
  '交付完整性',
  '交付完整性 - 描述',
  '操作系统',
  '任务类型',
];
const row = {
  taskId: 'task-a',
  turnId: 'turn-a',
  source: 'ai',
  eligible: true,
  values: [
    '给排练人员做一个舞台布置网页。',
    'native-session',
    'native-turn',
    '第一轮',
    'https://github.com/owner/project/commit/' + 'a'.repeat(40),
    'turn.jsonl',
    4,
    '入口拖动后仅当前幕的位置改变。',
    'MacOS/Linux',
    'feature迭代',
  ],
};
const schema = {
  fingerprint: 'schema-1',
  attachment_max_mb: 20,
  fields: [
    { field_key: 'user_prompt', label: 'User Prompt', is_required: true },
    { field_key: 'session_id', label: 'SessionID', is_required: true },
    { field_key: 'turn_id', label: 'TurnID/PromptID', is_required: true },
    { field_key: 'round_no', label: '当前对话轮次排序', is_required: true },
    { field_key: 'env_snapshot', label: '初始环境快照', is_required: true },
    {
      field_key: 'trace_file',
      label: '轨迹文件',
      is_required: true,
      field_type: 'attachment',
    },
    { field_key: 'score_delivery', label: '交付完整性', is_required: true },
    {
      field_key: 'desc_delivery',
      label: '交付完整性 - 描述',
      is_required: true,
    },
    {
      field_key: 'question_type',
      label: '任务类型',
      is_required: true,
      options: ['feature迭代', 'Bug修复'],
    },
  ],
};
const bytes = Buffer.from(
  'synthetic JSONL supplied by injected verified package builder',
);
const file = {
  bytes,
  name: 'native.jsonl',
  sha256: digest(bytes),
  status: 'passed',
  policyVersion: soloNativeAttachmentVersion,
  byteIdentical: true,
  format: 'jsonl',
};
function fixture() {
  const remote = [],
    requests = [],
    snapshots = [],
    ledger = {};
  const client = {
    list: async () => ({
      items: remote.map(({ id, session_id }) => ({ id, session_id })),
      meta: { total: remote.length },
    }),
    detail: async (id) => structuredClone(remote.find((x) => x.id === id)),
    upload: async (f) => {
      requests.push('upload');
      return {
        name: f.name,
        path: 'uploads/native.jsonl',
        size: f.bytes.length,
      };
    },
    create: async (p) => {
      requests.push('create');
      const r = { id: remote.length + 1, status: 'SUBMITTED', ...p.data };
      remote.push(r);
      return { id: r.id, status: r.status };
    },
  };
  const args = {
    client,
    rows: [row],
    headers,
    schema,
    ledger,
    save: (x) => snapshots.push(structuredClone(x)),
    prepareAttachment: async () => file,
    currentRow: async () => row,
  };
  return { remote, requests, snapshots, ledger, client, args };
}

test('maps actual record columns, preserves native IDs, and never invents required values', () => {
  const p = mapRecord(row, headers, schema, [
    { name: 'native.jsonl', path: 'x', size: 1 },
  ]);
  assert.equal(p.data.session_id, 'native-session');
  assert.equal(p.data.round_no, '第一轮');
  assert.equal(p.data.score_delivery, 4);
  assert.throws(
    () =>
      mapRecord(
        row,
        headers,
        {
          ...schema,
          fields: [
            ...schema.fields,
            { field_key: 'new_required', is_required: true },
          ],
        },
        [{}],
      ),
    /new_required/,
  );
  assert.throws(
    () => mapRecord({ ...row, eligible: false }, headers, schema, [{}]),
    /导出校验/,
  );
});
test('handles numeric and Chinese round presentation without renumbering', () => {
  const p = mapRecord(row, headers, schema, [
    { name: 'n', path: 'p', size: 1 },
  ]);
  assert.equal(sameRemote({ ...p.data, round_no: 1 }, p), true);
  assert.equal(sameRemote({ ...p.data, round_no: 2 }, p), false);
});
test('successful submit is durable before POST, then read back; second run only refreshes', async () => {
  const f = fixture();
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
  assert.equal(f.ledger.entries['task-a:turn-a'].receiptVerified, true);
  assert.ok(
    f.snapshots.find(
      (x) =>
        x.entries['task-a:turn-a'].state === 'submitting' &&
        x.entries['task-a:turn-a'].payload,
    ),
  );
  f.remote[0].status = 'QC_PASSED';
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
  assert.equal(f.ledger.entries['task-a:turn-a'].remoteStatus, 'QC_PASSED');
});
test('uncertain POST accepted by server is reconciled without another attachment or create', async () => {
  const f = fixture(),
    create = f.client.create;
  f.client.create = async (p) => {
    await create(p);
    throw new SoloError('lost response', { uncertain: true });
  };
  await syncRecords(f.args);
  assert.equal(f.ledger.entries['task-a:turn-a'].state, 'uncertain');
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
  assert.equal(f.ledger.entries['task-a:turn-a'].remoteId, 1);
});
test('uncertain POST with no remote result stays uncertain instead of blind retry', async () => {
  const f = fixture();
  f.client.create = async () => {
    f.requests.push('create');
    throw new SoloError('timeout', { uncertain: true });
  };
  await syncRecords(f.args);
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
  assert.equal(f.ledger.entries['task-a:turn-a'].state, 'uncertain');
});
test('a restart from durable submitting state never replays POST', async () => {
  const f = fixture();
  f.ledger.entries = { 'task-a:turn-a': { state: 'submitting' } };
  await syncRecords(f.args);
  assert.deepEqual(f.requests, []);
  assert.equal(f.ledger.entries['task-a:turn-a'].state, 'uncertain');
});
test('same native identifiers with different data do not overwrite or create another record', async () => {
  const f = fixture();
  f.remote.push({
    id: 8,
    session_id: 'native-session',
    turn_id: 'native-turn',
    user_prompt: 'another prompt',
  });
  await syncRecords(f.args);
  assert.deepEqual(f.requests, []);
  assert.equal(f.ledger.entries['task-a:turn-a'].state, 'conflict');
});
test('local eligibility revoked while preparing prevents attachment upload', async () => {
  const f = fixture();
  f.args.currentRow = async () => ({ ...row, eligible: false });
  await syncRecords(f.args);
  assert.deepEqual(f.requests, []);
});
test('eligibility revoked after attachment prevents create but keeps upload receipt', async () => {
  const f = fixture();
  let reads = 0;
  f.args.currentRow = async () => ({ ...row, eligible: ++reads === 1 });
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload']);
  assert.ok(f.ledger.entries['task-a:turn-a'].attachment);
});
test('archive bytes, review status and size all gate uploading', async () => {
  for (const change of [
    { sha256: 'wrong' },
    { status: 'needs_review' },
    { name: 'internal.tar.gz' },
    { name: 'native.zip' },
    { format: 'zip' },
    { format: undefined },
    { policyVersion: undefined },
    { byteIdentical: false },
  ]) {
    const f = fixture();
    f.args.prepareAttachment = async () => ({ ...file, ...change });
    await syncRecords(f.args);
    assert.deepEqual(f.requests, []);
  }
  const f = fixture();
  f.args.schema = { ...schema, attachment_max_mb: 0.000001 };
  await syncRecords(f.args);
  assert.deepEqual(f.requests, []);
});
test('schema rejection is not retried with identical content', async () => {
  const f = fixture();
  f.client.create = async () => {
    f.requests.push('create');
    throw new SoloError('invalid', { status: 422 });
  };
  await syncRecords(f.args);
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
});
test('readback outage keeps remote ID and validates complete fields next time', async () => {
  const f = fixture(),
    detail = f.client.detail;
  let first = true;
  f.client.detail = async (id) => {
    if (first) {
      first = false;
      throw Error('read outage');
    }
    return detail(id);
  };
  await syncRecords(f.args);
  assert.equal(f.ledger.entries['task-a:turn-a'].remoteId, 1);
  await syncRecords(f.args);
  assert.deepEqual(f.requests, ['upload', 'create']);
  assert.equal(f.ledger.entries['task-a:turn-a'].receiptVerified, true);
});
test('SOLO client pins HTTPS origin, sends CSRF, and refuses redirects', async () => {
  const calls = [];
  const c = new SoloClient({
    auth: {
      origin: SOLO_ORIGIN,
      cookies: [
        { name: 'solo_qa_csrf', value: 'encoded%20csrf' },
        { name: 'session', value: 'secret-cookie' },
      ],
    },
    fetchImpl: async (url, opt) => {
      calls.push({ url, opt });
      return Response.json({ id: 1 });
    },
  });
  await c.create({ data: {}, schema_fingerprint: 's' });
  assert.equal(calls[0].url, SOLO_ORIGIN + '/api/v1/submissions');
  assert.equal(calls[0].opt.headers['X-CSRF-Token'], 'encoded csrf');
  assert.equal(calls[0].opt.redirect, 'error');
  assert.throws(
    () =>
      new SoloClient({
        auth: { origin: 'https://other.example', cookies: [] },
      }),
  );
});
test('HTTP 401 is explicit, server 500 and malformed success are ambiguous writes', async () => {
  for (const [status, uncertain] of [
    [401, false],
    [422, false],
    [500, true],
  ]) {
    const c = new SoloClient({
      fetchImpl: async () =>
        Response.json({ detail: 'do not log submitted secret' }, { status }),
    });
    await assert.rejects(
      c.create({}),
      (e) => e.uncertain === uncertain && !e.message.includes('secret'),
    );
  }
  const c = new SoloClient({ fetchImpl: async () => new Response('not-json') });
  await assert.rejects(c.create({}), (e) => e.uncertain === true);
});
test('dedup scans all pages and examines detail when list omits native turn ID', async () => {
  const pages = [];
  const c = {
    list: async ({ page }) => {
      pages.push(page);
      return {
        items: page === 2 ? [{ id: 2, session_id: 's' }] : [],
        meta: { total: 101 },
      };
    },
    detail: async () => ({ id: 2, session_id: 's', turn_id: 't' }),
  };
  assert.equal(
    (await findRemote(c, { session_id: 's', turn_id: 't' })).length,
    1,
  );
  assert.deepEqual(pages, [1, 2]);
});

test('browser receipts require the observed account, native IDs and verified fields', async () => {
  const { validateReceipt } = await import('../scripts/solo-ui-queue.mjs');
  const packet = { fields: { SessionID: 's', 'TurnID/PromptID': 'p' } };
  const receipt = {
    remoteId: 618,
    remoteStatus: 'PENDING_FIX',
    sessionId: 's',
    promptId: 'p',
    fieldsVerified: true,
    account: '牛宇航',
  };
  assert.doesNotThrow(() => validateReceipt(packet, receipt));
  for (const change of [
    { remoteId: 0 },
    { remoteStatus: 'APPROVED' },
    { sessionId: 'wrong' },
    { promptId: 'wrong' },
    { fieldsVerified: false },
    { account: 'wrong' },
  ])
    assert.throws(
      () => validateReceipt(packet, { ...receipt, ...change }),
      /远端回执/,
    );
});

test('journal lock prevents concurrent writes and releases after exceptions', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { acquireSoloLock, withSoloLock } =
    await import('../scripts/solo-lock.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-lock-')),
    file = path.join(dir, 'lock');
  try {
    const release = acquireSoloLock(file);
    assert.throws(() => acquireSoloLock(file), /已有 SOLO/);
    release();
    await assert.rejects(
      withSoloLock(file, async () => {
        throw Error('fixture failure');
      }),
      /fixture failure/,
    );
    assert.equal(fs.existsSync(file), false);
    const next = acquireSoloLock(file);
    next();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser queue preserves genuine rounds and holds gaps, changed environments or easy first rounds', async () => {
  const { sequenceIssues } = await import('../scripts/solo-ui-queue.mjs');
  const hs = ['SessionID', '当前对话轮次排序', '初始环境快照', '任务难度'];
  const make = (n, extra = {}) => ({
    taskId: 't',
    turnId: 'q' + n,
    eligible: true,
    values: ['s', n, 'same-commit', '中等'],
    ...extra,
  });
  assert.equal(sequenceIssues([make(1), make(2), make(3)], hs).size, 0);
  const held = sequenceIssues(
    [
      make(1, { eligible: false, uploadHold: { reason: '人工明确禁止上传' } }),
      make(2),
      make(3),
    ],
    hs,
  );
  assert.equal(held.size, 2);
  assert.match(held.get('t:q2'), /首轮已被用户禁止上传/);
  assert.match(held.get('t:q3'), /不能越序提交/);
  assert.equal(sequenceIssues([make(1), make(3)], hs).has('t:q3'), true);
  assert.equal(
    sequenceIssues([make(1), make(2, { eligible: false }), make(3)], hs).has(
      't:q3',
    ),
    true,
  );
  assert.equal(
    sequenceIssues(
      [make(1), make(2, { values: ['s', 2, 'different', '中等'] })],
      hs,
    ).has('t:q2'),
    true,
  );
  assert.equal(
    sequenceIssues(
      [make(1, { values: ['s', 1, 'same-commit', '简单'] }), make(2)],
      hs,
    ).size,
    2,
  );
  assert.equal(
    sequenceIssues([make(1), make(1, { turnId: 'duplicate' })], hs).size,
    2,
  );
});

test('shared heartbeat admits each daytime even Shanghai hour once and preserves prior batches', async () => {
  const { uploadSlot, dueUpload } =
    await import('../scripts/solo-schedule.mjs');
  assert.equal(
    uploadSlot(new Date('2026-09-10T00:00:00Z')),
    '2026-09-10T08:00+08:00',
  );
  assert.equal(
    uploadSlot(new Date('2026-09-10T12:01:30Z')),
    '2026-09-10T20:00+08:00',
  );
  assert.equal(uploadSlot(new Date('2026-09-10T12:30:00Z')), null);
  assert.equal(uploadSlot(new Date('2026-09-10T03:00:00Z')), null);
  assert.equal(uploadSlot(new Date('2026-09-10T16:00:00Z')), null);
  assert.equal(
    dueUpload(new Date('2026-09-10T00:01:00Z'), {
      runs: { '2026-09-10T08:00+08:00': { status: 'running' } },
    }).due,
    false,
  );
  assert.equal(
    dueUpload(new Date('2026-09-11T00:00:00Z'), {
      runs: { '2026-09-10T08:00+08:00': { status: 'completed' } },
    }).due,
    true,
  );
});

test('uploads require verified final export of this exact question and container, never legacy', async () => {
  const { requireUploadFinalization } =
    await import('../scripts/solo-upload.mjs');
  const identity = {
    taskId: 't',
    questionId: 'q',
    containerId: 'c',
    sessionId: 's',
  };
  const final = {
    ...identity,
    commandTransport: 'original-mac-terminal',
    status: 'removed',
    traceExport: { sha256: 'final-tree-hash' },
  };
  assert.doesNotThrow(() => requireUploadFinalization(final, identity));
  assert.throws(() => requireUploadFinalization(null, identity), /等待本题/);
  assert.throws(
    () =>
      requireUploadFinalization(
        { ...final, commandTransport: 'legacy-runner-migration' },
        identity,
      ),
    /旧协议/,
  );
  for (const change of [
    { taskId: 'other' },
    { questionId: 'other' },
    { containerId: 'other' },
    { sessionId: 'other' },
    { status: 'running' },
    { emptyWithoutCalls: true },
    { traceExport: {} },
  ])
    assert.throws(
      () => requireUploadFinalization({ ...final, ...change }, identity),
      /不符/,
    );
});
