// Synthetic API fixtures only, on an isolated port 3001 database without a runner.
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { permissionAuditVersion } from '../lib/permission-audit.mjs';
import { initialCodeVersion } from '../lib/initial-code-snapshot.mjs';
import { submissionPolicyVersion } from '../lib/submission-policy.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
import { base } from './fixtures/test-server.mjs';
const ids = [],
  batches = [];
async function request(route, body, method = 'POST', auth = false) {
  return fetch(base + route, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function api(route, body, method = 'POST', auth = false) {
  const r = await request(route, body, method, auth);
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
const run = (b) => api('/api/runner', b, 'POST', true);
const original = (await api('/api/scheduler', null, 'GET')).config;
const latest = async (id) =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === id);
const filter = {
  source: 'ai',
  query: '__RECORDS_API__',
  exports: 'all',
  page: 1,
  pageSize: 10,
};
const records = (f) =>
  api('/api/records?' + new URLSearchParams({ ...filter, ...f }), null, 'GET');
async function exportFile(
  f = filter,
  scope = 'filtered',
  id = crypto.randomUUID(),
  format = 'xlsx',
  selected,
) {
  batches.push(id);
  writeFileSync(
    '.runner/records-export-batches',
    JSON.stringify([...new Set(batches)]),
  );
  return request('/api/export', {
    requestId: id,
    filter: f,
    scope,
    format,
    selected,
  });
}
try {
  await api('/api/scheduler', {
    ...original,
    enabled: false,
    autoContinue: false,
    concurrency: 1,
  });
  for (let i = 0; i < 12; i++) {
    const { task } = await api('/api/tasks', {
      title: '__RECORDS_API__' + i,
      repoPath: '/tmp/records-fixture',
      category: '0-1 代码生成',
      difficulty: '困难',
      stack: 'TypeScript',
      reproducibility: '无外部依赖',
      projectSeries: true,
      autoStart: true,
    });
    ids.push(task.id);
    writeFileSync('.runner/records-api-ids', JSON.stringify(ids));
    let { job } = await run({ action: 'claim', capacity: 1 });
    assert.equal(job.task.id, task.id);
    const sessionId = 'records-session-' + i;
    const container = {
      questionId: job.turn.id,
      containerId: 'a'.repeat(62) + i.toString(16).padStart(2, '0'),
      scaffoldSnapshot: {
        manifestPath: '/fixture/scaffold.json',
        sha256: 'c'.repeat(64),
        files: 1,
      },
      terminalIdentity: {
        transport: 'mac-terminal',
        runId: job.turn.id,
        realTerminal: true,
        tty: '/dev/fixture',
      },
      taskId: task.id,
      name: 'annotation-' + task.id,
      policyVersion: containerPolicyVersion,
      status: 'running',
      image: containerImage,
      imageId: 'sha256:' + 'a'.repeat(64),
      snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
      workDir: '/fixture/' + task.id + '/workspace',
    };
    await run({ action: 'container', taskId: task.id, container });
    const initial = {
      version: initialCodeVersion,
      engine: 'github-cli-initial-code',
      taskId: task.id,
      questionId: job.turn.id,
      repository: 'fixture/initial-code',
      sha: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      url: 'https://github.com/fixture/initial-code/commit/' + 'a'.repeat(40),
      isPrivate: true,
      files: 1,
      manifestSha256: 'c'.repeat(64),
      imageSnapshot: container.snapshot,
      publicationMode: 'before-run',
      verifiedAt: new Date().toISOString(),
    };
    const publish = {
      action: 'initial-code-snapshot',
      taskId: task.id,
      questionId: job.turn.id,
      snapshot: initial,
    };
    await assert.rejects(
      () =>
        run({
          ...publish,
          snapshot: { ...initial, manifestSha256: 'd'.repeat(64) },
        }),
      /不一致/,
    );
    await run(publish);
    await run(publish);
    const finish = (extra) =>
      run({
        action: 'finish',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        container,
        traceExport: {
          verified: true,
          path: '/fixture/projects',
          files: 1,
          sha256: 'a'.repeat(64),
        },
        permissionAudit: {
          version: permissionAuditVersion,
          passed: true,
          modeVerified: true,
          denialCount: 0,
          traceSha256: 'a'.repeat(64),
        },
        ...extra,
      });
    for (let n = 1; n <= (i === 0 ? 10 : 1); n++) {
      await run({
        action: 'stage',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        stage: 'claude',
      });
      const reserve = {
        action: 'reserve-claude',
        taskId: task.id,
        turnId: job.turn.id,
        jobToken: job.turn.jobToken,
        sessionId,
        attemptId: 'attempt-' + n,
      };
      assert.deepEqual(await run(reserve), { allowed: true, count: n });
      assert.deepEqual(
        await run(reserve),
        { allowed: true, count: n },
        'reservation retry must be idempotent',
      );
      await assert.rejects(
        () => run({ ...reserve, sessionId: 'different' }),
        /切换/,
      );
      if (i === 0 && n < 10) {
        await finish({
          success: false,
          sessionId,
          error: 'synthetic failed call',
        });
        const t = await latest(task.id);
        await api(
          '/api/tasks/' + task.id,
          { action: 'retry', turnId: job.turn.id, revision: t.revision },
          'PATCH',
        );
        ({ job } = await run({ action: 'claim', capacity: 1 }));
      }
    }
    if (i === 0) {
      const results = await Promise.all(
        Array.from({ length: 3 }, (_, j) =>
          run({
            action: 'reserve-claude',
            taskId: task.id,
            turnId: job.turn.id,
            jobToken: job.turn.jobToken,
            sessionId,
            attemptId: 'over-cap-' + j,
          }),
        ),
      );
      assert.ok(results.every((r) => !r.allowed && r.count === 10));
    }
    await assert.rejects(
      () => finish({ success: true, contextCheck: { ready: false } }),
      /上下文/,
    );
    await assert.rejects(
      () =>
        finish({
          success: true,
          permissionAudit: {
            version: permissionAuditVersion,
            passed: false,
            modeVerified: true,
            denialCount: 5,
          },
        }),
      /权限/,
    );
    const archive = {
      archivePath:
        '/fixture/' + task.id + '/' + job.turn.id + '.evidence.tar.gz',
      sha256: 'b'.repeat(64),
      files: 1,
    };
    await finish({
      success: true,
      sessionId,
      promptId: 'records-prompt-' + i,
      preparedPrompt: '=1+1\n中文<&" ' + i,
      tracePath: '/fixture/trajectory-' + i,
      snapshot: container.snapshot,
      harnessVersion: 'fixture-2.1',
      os: 'macOS',
      review: {
        source: 'codex',
        scores: [1, 2, 3, 4, 5],
        descriptions: [
          '交付观察',
          '指令观察',
          '规划观察',
          '推理观察',
          '执行观察',
        ],
        other: '联系人 private.person@fixture-email.local',
      },
      automation: {
        bundlePath: '/fixture/bundle',
        archive,
        delivery: { value: { passed: true } },
      },
    });
    const pendingFinalization = await records({ projectId: task.id });
    assert.equal(pendingFinalization.rows.length, 1);
    assert.equal(
      pendingFinalization.rows[0].eligible,
      false,
      'scoring and intermediate export cannot bypass final submission verification',
    );
    const checkedAt = new Date().toISOString();
    const finalRoot =
      '/fixture/' + task.id + '/' + job.turn.id + '.final.traces-synthetic';
    const submissionRoot =
      '/fixture/' + task.id + '/' + job.turn.id + '.submission-synthetic';
    await run({
      action: 'submission-package',
      taskId: task.id,
      turnId: job.turn.id,
      sourceArchiveSha256: archive.sha256,
      submission: {
        version: submissionPolicyVersion,
        status: 'passed',
        archivePath: submissionRoot + '.tar.gz',
        sha256: 'c'.repeat(64),
        zipArchivePath: submissionRoot + '.zip',
        zipSha256: 'd'.repeat(64),
        zipBytes: 256,
        manifestPath: submissionRoot + '/manifest.json',
        manifestSha256: 'e'.repeat(64),
        files: 1,
        redactions: [],
        reviewRequiredFiles: [],
        sourceArchiveSha256: archive.sha256,
        traceExportSha256: 'f'.repeat(64),
        verifiedAt: checkedAt,
        finalization: {
          version: '2026-09-10.terminal-finalization1',
          taskId: task.id,
          questionId: job.turn.id,
          runId: container.terminalIdentity.runId,
          sessionId,
          containerId: container.containerId,
          status: 'removed',
          commandTransport: 'original-mac-terminal',
          traceExport: {
            verified: true,
            path: finalRoot + '/projects',
            manifestPath: finalRoot + '/manifest.json',
            files: 1,
            sha256: 'f'.repeat(64),
            exportedAt: checkedAt,
            exportKind: 'final',
            commandTransport: 'original-mac-terminal',
          },
          manifestSha256: '1'.repeat(64),
          removedAt: checkedAt,
          emptyWithoutCalls: false,
          receiptPath:
            '/fixture/' +
            task.id +
            '/questions/' +
            job.turn.id +
            '/terminal/finalization.json',
          receiptSha256: '2'.repeat(64),
        },
      },
    });
    assert.equal(
      (await records({ projectId: task.id })).rows[0].eligible,
      true,
    );
    if (i === 0) {
      const t = await latest(task.id);
      assert.equal(t.turns[0].claudeAttempts.length, 10);
      await assert.rejects(
        () =>
          api(
            '/api/tasks/' + task.id,
            {
              action: 'enqueue',
              revision: t.revision,
              prompt: '筛选后列表没有更新，把列表刷新逻辑修好',
              category: 'Bug 修复',
              difficulty: '困难',
            },
            'PATCH',
          ),
        /会话|修复|10/,
      );
    }
  }
  let edited = await latest(ids[1]);
  const metadata = {
    parentRecord: 'external-1',
    auditNote: '人工核对日期字段',
    parentRecord2: '',
  };
  const metadataBody = {
    action: 'record-metadata',
    turnId: edited.turns[0].id,
    metadata,
    revision: edited.revision,
  };
  await api('/api/tasks/' + edited.id, metadataBody, 'PATCH');
  await assert.rejects(
    () => api('/api/tasks/' + edited.id, metadataBody, 'PATCH'),
    /数据已更新/,
  );
  edited = await latest(edited.id);
  assert.equal(edited.turns[0].metadataHistory.length, 1);
  let data = await records({});
  assert.equal(data.total, 12);
  assert.equal(data.rows.length, 10);
  assert.equal(data.headers.length, 30);
  assert.ok(data.rows.every((r) => r.eligible));
  assert.ok(data.rows.every((r) => r.values[3] === '第一轮'));
  assert.ok(
    data.rows.every((r) =>
      r.values[4].startsWith('https://github.com/fixture/initial-code/commit/'),
    ),
  );
  const editedRow = await records({ query: '__RECORDS_API__1', pageSize: 20 });
  assert.deepEqual(
    editedRow.rows.find((r) => r.taskId === edited.id).values.slice(-3),
    ['external-1', '人工核对日期字段', ''],
  );
  const page2 = await records({ page: 2 });
  assert.equal(page2.rows.length, 2);
  assert.ok(
    !page2.rows.some((r) => data.rows.some((a) => a.turnId === r.turnId)),
  );
  assert.equal((await records({ page: 999 })).page, 2);
  assert.equal((await records({ category: 'Bug 修复' })).total, 0);
  assert.equal((await records({ query: "' OR 1=1 --" })).total, 0);
  const oneProject = await records({ projectId: ids[2], page: 999 });
  assert.equal(oneProject.total, 1);
  assert.equal(oneProject.page, 1);
  assert.equal(oneProject.rows[0].taskId, ids[2]);
  assert.equal((await records({ projectId: 'missing' })).total, 0);
  assert.equal(
    (await records({ projectId: ids[2], category: 'Bug 修复' })).total,
    0,
  );
  assert.ok(!oneProject.headers.includes('项目名称'));
  const id = crypto.randomUUID(),
    first = await exportFile(filter, 'page', id);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get('X-Export-Count'), '10');
  assert.equal(first.headers.get('X-Export-Originals-Preserved'), 'true');
  assert(Number(first.headers.get('X-Export-Redactions')) >= 10);
  const bytes = new Uint8Array(await first.arrayBuffer());
  const xml = Object.values(unzipSync(bytes))
    .map((value) => strFromU8(value))
    .join('\n');
  assert(xml.includes('[REDACTED_EMAIL]'));
  assert(!xml.includes('private.person@fixture-email.local'));
  assert(
    (await latest(ids[0])).turns[0].review.other.includes(
      'private.person@fixture-email.local',
    ),
  );
  writeFileSync('.runner/records-fixture.xlsx', bytes);
  const again = await exportFile(filter, 'page', id);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('X-Export-Count'), '10');
  assert.equal((await records({ exports: 'exact', count: 1 })).total, 10);
  assert.equal((await records({ exports: 'never' })).total, 2);
  assert.equal(
    (await exportFile({ ...filter, category: 'Bug 修复' }, 'page', id)).status,
    400,
  );
  const id2 = crypto.randomUUID(),
    concurrent = await Promise.all([
      exportFile({ ...filter, exports: 'never' }, 'filtered', id2),
      exportFile({ ...filter, exports: 'never' }, 'filtered', id2),
    ]);
  assert.ok(concurrent.every((r) => r.status === 200));
  assert.ok(concurrent.every((r) => r.headers.get('X-Export-Count') === '2'));
  assert.equal((await records({ exports: 'exact', count: 1 })).total, 12);
  const all = await exportFile(filter, 'filtered', crypto.randomUUID(), 'csv');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('X-Export-Count'), '12');
  const csvText = await all.text();
  assert.ok(csvText.startsWith('"序号","User Prompt","SessionID"'));
  assert(csvText.includes('[REDACTED_EMAIL]'));
  assert(!csvText.includes('private.person@fixture-email.local'));
  assert.equal((await records({ exports: 'exact', count: 2 })).total, 12);
  const selected = [data.rows[0], page2.rows[0]].map(({ taskId, turnId }) => ({
    taskId,
    turnId,
  }));
  for (const invalid of [
    [],
    [selected[0], selected[0]],
    [selected[0], { taskId: 'missing', turnId: 'missing' }],
  ]) {
    assert.equal(
      (
        await exportFile(
          filter,
          'selected',
          crypto.randomUUID(),
          'xlsx',
          invalid,
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await exportFile(
        { ...filter, category: 'Bug 修复' },
        'selected',
        crypto.randomUUID(),
        'xlsx',
        selected,
      )
    ).status,
    400,
  );
  assert.equal((await exportFile(filter, 'typo')).status, 400);
  assert.equal(
    (await records({ exports: 'exact', count: 2 })).total,
    12,
    'invalid selections never increase counts',
  );
  const selectedId = crypto.randomUUID();
  const chosen = await exportFile(
    filter,
    'selected',
    selectedId,
    'csv',
    selected,
  );
  assert.equal(chosen.status, 200, await chosen.clone().text());
  assert.equal(
    chosen.headers.get('X-Export-Count'),
    '2',
    'selected export spans pages',
  );
  const chosenCsv = await chosen.text();
  assert.ok(
    chosenCsv.includes('"1","=') === false,
    'CSV formula protection remains active',
  );
  for (const row of [data.rows[0], page2.rows[0]])
    assert.ok(chosenCsv.includes(row.values[2]));
  assert.ok(!chosenCsv.includes(data.rows[1].values[2]));
  assert.equal(
    (
      await exportFile(
        filter,
        'selected',
        selectedId,
        'csv',
        [...selected].reverse(),
      )
    ).status,
    200,
  );
  assert.equal(
    (await exportFile(filter, 'selected', selectedId, 'csv', [selected[0]]))
      .status,
    400,
  );
  assert.equal((await records({ exports: 'exact', count: 3 })).total, 2);
  assert.equal((await records({ exports: 'exact', count: 2 })).total, 10);
  assert.equal((await records({ exports: 'never' })).total, 0);
  assert.equal((await exportFile({ ...filter, exports: 'never' })).status, 400);
  assert.equal((await records({ exports: 'exact', count: 2 })).total, 10);
  // A subsequent failure contaminates its entire question session, including old batches.
  const clean = await latest(ids[9]);
  await api(
    '/api/tasks/' + clean.id,
    {
      action: 'enqueue',
      prompt: '列表切换筛选后没有回到第一页，把页码重置并检查空列表',
      category: 'Bug 修复',
      difficulty: '困难',
      revision: clean.revision,
    },
    'PATCH',
  );
  const { job: continuation } = await run({ action: 'claim', capacity: 1 });
  assert.equal(continuation.turn.questionRootId, clean.turns[0].questionRootId);
  assert.equal(continuation.turn.roundNumber, 2);
  await run({
    action: 'stage',
    taskId: clean.id,
    turnId: continuation.turn.id,
    jobToken: continuation.turn.jobToken,
    stage: 'claude',
  });
  await run({
    action: 'reserve-claude',
    taskId: clean.id,
    turnId: continuation.turn.id,
    jobToken: continuation.turn.jobToken,
    sessionId: clean.sessionId,
    attemptId: 'denial-check',
  });
  await run({
    action: 'finish',
    taskId: clean.id,
    turnId: continuation.turn.id,
    jobToken: continuation.turn.jobToken,
    success: false,
    sessionId: clean.sessionId,
    container: clean.container,
    permissionAudit: {
      version: permissionAuditVersion,
      passed: false,
      modeVerified: true,
      denialCount: 1,
    },
    error: 'synthetic permission-rule denial',
  });
  const invalid = await records({ query: clean.sessionId });
  assert.ok(invalid.rows.every((r) => !r.eligible));
  assert.equal(
    (
      await exportFile(filter, 'selected', crypto.randomUUID(), 'xlsx', [
        { taskId: clean.id, turnId: clean.turns[0].id },
      ])
    ).status,
    400,
  );
  assert.equal(
    (await exportFile({ ...filter, query: clean.sessionId })).status,
    400,
  );
  assert.equal(
    (await exportFile(filter, 'page', id)).status,
    400,
    'old batch must not bypass a later permission denial',
  );
  const projectFile = await exportFile(
    { ...filter, projectId: ids[2] },
    'filtered',
    crypto.randomUUID(),
    'csv',
  );
  assert.equal(projectFile.status, 200);
  assert.equal(projectFile.headers.get('X-Export-Count'), '1');
  const projectCsv = await projectFile.text();
  assert.ok(!projectCsv.split('\n')[0].includes('项目名称'));
  assert.equal(
    (
      await exportFile(
        { ...filter, projectId: ids[2] },
        'selected',
        crypto.randomUUID(),
        'xlsx',
        [{ taskId: ids[3], turnId: (await latest(ids[3])).turns[0].id }],
      )
    ).status,
    400,
  );
  console.log(
    'Records API passed: serial plus 30 fields, 12 records on two pages, selected export, stale/invalid selection rejection, exact counts, XLSX/CSV, idempotent retries and permission gates.',
  );
} finally {
  await api('/api/scheduler', original);
}
