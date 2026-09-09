import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditPermissionTraces,
  permissionIssues,
  verifyPermissionPreflight,
  permissionAuditVersion,
  taskTools,
} from '../lib/permission-audit.mjs';
const trace = (events) => [
  {
    name: '-workspace/session.jsonl',
    content: events.map((e) => JSON.stringify(e)).join('\n'),
  },
];
const mode = { type: 'permission-mode', permissionMode: 'bypassPermissions' };
const call = (id, name = 'Bash') => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id, name, input: { command: 'test' } }],
  },
});
const result = (id, content, is_error = true, extra = {}) => ({
  type: 'user',
  uuid: 'event-' + id,
  message: {
    content: [
      { type: 'tool_result', tool_use_id: id, content, is_error, ...extra },
    ],
  },
});
test('Read/Write/Bash permission-rule denials invalidate the whole native session', () => {
  const events = [
    mode,
    ...Array.from({ length: 5 }, (_, i) =>
      call('t' + i, i < 3 ? 'Bash' : 'Read'),
    ),
    ...Array.from({ length: 5 }, (_, i) =>
      result(
        't' + i,
        'Permission to use ' + (i < 3 ? 'Bash' : 'Read') + ' has been denied',
        true,
        { toolDenialKind: 'permission-rule' },
      ),
    ),
  ];
  const a = auditPermissionTraces(trace(events));
  assert.equal(a.denialCount, 5);
  assert.equal(a.passed, false);
  assert.equal(a.findings.filter((x) => x.tool === 'Bash').length, 3);
  assert.equal(
    auditPermissionTraces(
      trace([...events, call('later'), result('later', 'success', false)]),
    ).passed,
    false,
    'a later success cannot erase a prior denial',
  );
});
test('Permission strings in prompts, successful source reads and model commentary are not tool denials', () => {
  const a = auditPermissionTraces(
    trace([
      mode,
      {
        type: 'user',
        message: { content: 'Permission to use Bash has been denied' },
      },
      call('read', 'Read'),
      result('read', '1: Permission to use Bash has been denied', false),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'permission denied' }] },
      },
    ]),
  );
  assert.equal(a.passed, true);
  assert.equal(a.denialCount, 0);
  assert.equal(a.toolCalls, 1);
});
test('Hooks, OS file permissions, external 403 and approval mode switches are rejected', () => {
  for (const message of [
    'PreToolUse hook blocked command',
    'EACCES: permission denied',
    'Read-only file system',
    '403 Forbidden',
  ]) {
    const a = auditPermissionTraces(
      trace([mode, call('t'), result('t', message)]),
    );
    assert.equal(a.passed, false, message);
    assert.equal(a.denialCount, 1);
  }
  assert.equal(
    auditPermissionTraces(trace([mode, { ...mode, permissionMode: 'default' }]))
      .passed,
    false,
  );
  assert.equal(auditPermissionTraces(trace([])).passed, false);
});
test('Preflight needs all six allowed tools and write access; export requires matching audited bytes', () => {
  const good = {
    skipPermissions: true,
    settingsIsolated: true,
    hooksIsolated: true,
    mcpIsolated: true,
    workspaceWritable: true,
    tools: taskTools,
  };
  assert.equal(verifyPermissionPreflight(good).passed, true);
  for (const key of [
    'skipPermissions',
    'settingsIsolated',
    'hooksIsolated',
    'mcpIsolated',
    'workspaceWritable',
  ])
    assert.throws(() => verifyPermissionPreflight({ ...good, [key]: false }));
  assert.throws(() => verifyPermissionPreflight({ ...good, tools: ['Read'] }));
  const permissionAudit = {
    ...auditPermissionTraces(trace([mode])),
    traceSha256: 'a',
  };
  assert.deepEqual(
    permissionIssues({
      permissionAudit,
      traceExport: { verified: true, sha256: 'a' },
    }),
    [],
  );
  assert.ok(
    permissionIssues({
      permissionAudit,
      traceExport: { verified: true, sha256: 'b' },
    }).length,
  );
  assert.ok(
    permissionIssues({
      permissionAudit: {
        ...permissionAudit,
        version: permissionAuditVersion,
        denialCount: 1,
      },
      traceExport: { verified: true, sha256: 'a' },
    }).length,
  );
});
