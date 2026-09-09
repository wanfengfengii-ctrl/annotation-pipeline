export function terminalIssues(record) {
  const terminal = record.container?.terminalIdentity;
  if (
    !terminal ||
    terminal.transport !== 'mac-terminal' ||
    terminal.realTerminal !== true ||
    !terminal.tty ||
    !terminal.runId
  )
    return ['缺少 Mac Terminal 实际终端执行记录'];
  return [];
}
