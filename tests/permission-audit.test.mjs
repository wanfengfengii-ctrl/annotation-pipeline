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
const aptDenied =
  'node\n/bin/bash: line 1: sudo: command not found\n' +
  'E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\n' +
  'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?';
test('apt permission denial survives a successful tail and later user-space install', () => {
  const apt = call('apt');
  apt.message.content[0].input.command =
    'whoami; sudo -n true 2>&1; apt-get install -y python3.11-venv 2>&1 | tail -3';
  const files = trace([
    mode,
    apt,
    result('apt', aptDenied, false),
    call('pip'),
    result('pip', 'pip install succeeded', false),
  ]);
  const original = structuredClone(files);
  const audit = auditPermissionTraces(files);
  assert.equal(audit.passed, false);
  assert.equal(audit.denialCount, 1);
  assert.equal(audit.findings[0].tool, 'Bash');
  assert.equal(audit.findings[0].kind, 'filesystem');
  assert.equal(audit.findings[0].toolUseId, 'apt');
  assert.deepEqual(files, original);
});
test('successful reads of apt diagnostics and non-permission apt failures are not denials', () => {
  for (const name of ['Read', 'Bash']) {
    const read = call('read', name);
    read.message.content[0].input.command = 'cat previous-install.log';
    assert.equal(
      auditPermissionTraces(
        trace([mode, read, result('read', aptDenied, false)]),
      ).denialCount,
      0,
    );
  }
  const apt = call('apt');
  apt.message.content[0].input.command = 'apt-get install missing | tail -3';
  assert.equal(
    auditPermissionTraces(
      trace([
        mode,
        apt,
        result('apt', 'E: Unable to locate package missing', false),
      ]),
    ).denialCount,
    0,
  );
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
