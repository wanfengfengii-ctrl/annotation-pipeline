export const permissionAuditVersion = '2026-09-09.permissions1';
export const taskTools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

export function verifyPermissionPreflight(value) {
  if (
    !value?.skipPermissions ||
    !value.settingsIsolated ||
    !value.hooksIsolated ||
    !value.mcpIsolated ||
    !value.workspaceWritable ||
    !taskTools.every((t) => value.tools?.includes(t))
  )
    throw Error('作业权限预检未通过：需免审批模式、隔离配置及可读写的任务目录');
  return { ...value, version: permissionAuditVersion, passed: true };
}

function typedDenial(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.toolDenialKind === 'string' && value.toolDenialKind)
    return value.toolDenialKind;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'input' || key === 'text' || key === 'content') continue;
    const found = typedDenial(child);
    if (found) return found;
  }
  return null;
}
function maskedPackagePermission(text, call) {
  // A shell pipeline can return success from tail while apt itself was denied.
  // Require an actual package-manager call and native failure diagnostics;
  // reading a source file or an old error log must not count as a new denial.
  if (
    call?.name !== 'Bash' ||
    !/(?:^|[;&|\n])\s*(?:\/usr\/bin\/)?apt(?:-get)?\s+(?:(?:-o|--option)\s+[^\s;&|]+\s+|-[^\s;&|]+\s+)*(?:install|update|upgrade|remove|purge|autoremove)\b/.test(
      call.input?.command || '',
    )
  )
    return null;
  const lockDenied =
    /^E:\s+Could not open lock file \/var\/(?:lib\/(?:dpkg|apt)|cache\/apt)\/[^\r\n]+\(13: Permission denied\)\s*$/im.test(
      text,
    ) && /^E:\s+Unable to acquire[^\r\n]+are you root\?/im.test(text);
  // apt's cleanup hook can fail even with writable redirected lists/cache.
  // Only count the actual rm diagnostic in an apt operation, not a log read.
  const cleanupDenied =
    /^rm:\s+cannot remove ['“‘]?\/var\/cache\/apt\/archives\/[^\r\n]+:\s+Permission denied\s*$/im.test(
      text,
    );
  return lockDenied || cleanupDenied ? 'filesystem' : null;
}
function denialText(text, isError) {
  if (
    /^\s*(?:Error:\s*)?Permission to use\b[\s\S]{0,200}?has been denied/i.test(
      text,
    )
  )
    return 'permission-rule';
  if (!isError) return null;
  if (
    /permission to use[\s\S]{0,200}has been denied|permission.rule|(?:tool|command)[\s\S]{0,80}(?:denied|not allowed)|(?:permission|approval)[\s\S]{0,80}(?:denied|required)|权限[\s\S]{0,40}(?:拒绝|禁止)/i.test(
      text,
    )
  )
    return 'permission-rule';
  if (
    /hook[\s\S]{0,100}(?:block|denied|reject)|(?:block|denied|reject)[\s\S]{0,100}hook/i.test(
      text,
    )
  )
    return 'hook';
  if (
    /EACCES|EPERM|permission denied|operation not permitted|read.only file system|sandbox[\s\S]{0,80}(?:denied|blocked)/i.test(
      text,
    )
  )
    return 'filesystem';
  if (
    /\b(?:401|403)\b[\s\S]{0,80}(?:forbidden|unauthorized|denied)|(?:forbidden|unauthorized)[\s\S]{0,80}\b(?:401|403)\b/i.test(
      text,
    )
  )
    return 'external-access';
  return null;
}

// Read only native events, not user prompts, model commentary or source-code quotations.
// Findings point back to the unmodified file; no rejected events are removed or rewritten.
export function auditPermissionTraces(files) {
  const events = [],
    toolNames = new Map(),
    toolCalls = new Map(),
    findings = new Map(),
    modes = [];
  for (const file of files) {
    for (const [i, line] of file.content.split('\n').entries()) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw Error('权限审计需要完整有效的原始 JSONL');
      }
      const ref = { file: file.name, line: i + 1 };
      events.push({ event, ref });
      if (event.type === 'permission-mode') modes.push(event.permissionMode);
      if (event.type === 'assistant' && Array.isArray(event.message?.content))
        for (const c of event.message.content)
          if (c.type === 'tool_use') {
            toolNames.set(c.id, c.name);
            toolCalls.set(c.id, c);
          }
    }
  }
  function add(event, ref, id, kind, name) {
    findings.set(
      [event.sessionId || '', id || event.uuid || ref.line, kind].join('|'),
      {
        ...ref,
        eventId: event.uuid,
        toolUseId: id,
        tool: name || toolNames.get(id) || '未知工具',
        kind,
      },
    );
  }
  for (const { event, ref } of events) {
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const c of event.message.content) {
        if (c.type !== 'tool_result') continue;
        const text =
          typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? c.content
                  .filter((x) => x.type === 'text')
                  .map((x) => x.text)
                  .join('\n')
              : '';
        const kind =
          typedDenial(c) ||
          typedDenial(event) ||
          denialText(text, c.is_error === true) ||
          maskedPackagePermission(text, toolCalls.get(c.tool_use_id));
        if (kind) add(event, ref, c.tool_use_id, kind);
      }
    } else if (
      event.type === 'system' ||
      event.type === 'tool-denial' ||
      event.type === 'tool_denial'
    ) {
      const kind =
        typedDenial(event) ||
        (/permission.denied|hook.denied/.test(event.subtype || '')
          ? event.subtype
          : null);
      if (kind)
        add(
          event,
          ref,
          event.tool_use_id || event.toolUseId,
          kind,
          event.toolName,
        );
    }
  }
  const denials = [...findings.values()];
  const modeVerified =
    modes.length > 0 && modes.every((m) => m === 'bypassPermissions');
  return {
    version: permissionAuditVersion,
    checksVersion: '2026-09-10.shell-permissions2',
    passed: modeVerified && denials.length === 0,
    modeVerified,
    mode: modeVerified ? 'bypassPermissions' : '未确认或发生切换',
    scope: '完整会话目录中的全部原始 JSONL',
    toolCalls: toolNames.size,
    tools: [...new Set(toolNames.values())],
    denialCount: denials.length,
    findings: denials,
    checkedAt: new Date().toISOString(),
  };
}

export function permissionIssues(record) {
  const audit = record.permissionAudit;
  if (!audit || audit.version !== permissionAuditVersion)
    return ['缺少当前规则的完整轨迹权限核验'];
  if (!audit.passed || !audit.modeVerified || audit.denialCount !== 0)
    return ['轨迹包含权限拒绝或未使用免审批模式，需新建任务重新采集'];
  if (
    !record.traceExport?.verified ||
    audit.traceSha256 !== record.traceExport.sha256
  )
    return ['权限核验与完整轨迹归档不匹配'];
  return [];
}
