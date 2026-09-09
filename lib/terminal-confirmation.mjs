const compact = (text) =>
  text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\s/g, '');

// Deliberately accept a small shell grammar. This is a convenience allowlist,
// not a shell sandbox; container ownership and isolation are verified separately.
export function localCommandDecision(command, directory) {
  const no = (reason) => ({ allowed: false, reason });
  if (!/^projects\/p-[a-f0-9-]{36}$/.test(directory || ''))
    return no('缺少本题项目目录');
  const root = '/workspace/' + directory;
  const source = command.replace(/\\\r?\n/g, '');
  if (/[`$(){}\\\x00-\x08\x0b-\x1f]/.test(source))
    return no('命令包含替换、脚本块或未支持的 Shell 语法');
  const pattern =
    /"[^"\n]*"|'[^'\n]*'|[12]?>&[12]|&&|\|\||[;&|\n]|[12]?>>?|[^\s;&|<>"']+/gy;
  const tokens = [];
  let at = 0;
  while (at < source.length) {
    if (/[ \t\r]/.test(source[at])) {
      at++;
      continue;
    }
    pattern.lastIndex = at;
    const m = pattern.exec(source);
    if (!m) return no('命令语法不在自动确认范围');
    tokens.push(/^['"]/.test(m[0]) ? m[0].slice(1, -1) : m[0]);
    at = pattern.lastIndex;
  }
  const localPath = (s) =>
    s === '/dev/null' ||
    (!s.startsWith('~') &&
      !s.split('/').includes('..') &&
      !/(?:^|\/)(?:\.ssh|\.claude|\.codex|\.env[^/]*)(?:\/|$)/.test(s) &&
      (!s.startsWith('/') || s === root || s.startsWith(root + '/')));
  const groups = [];
  let words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^(?:&&|\|\||[;&|\n])$/.test(token)) {
      if (words.length) groups.push(words);
      words = [];
      continue;
    }
    if (/^[12]?>&[12]$/.test(token)) continue;
    if (/^[12]?>>?$/.test(token)) {
      const dest = tokens[++i];
      if (!dest || /^[;&|<>]/.test(dest) || !localPath(dest))
        return no('输出重定向越出项目或语法不支持');
      continue;
    }
    words.push(token);
  }
  if (words.length) groups.push(words);
  if (!groups.length) return no('没有可确认的命令');
  for (const [cmd, ...args] of groups) {
    for (const arg of args) {
      for (const url of arg.match(/https?:\/\/[^\s'";]+/g) || []) {
        try {
          if (
            !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
          )
            return no('包含非本机网络地址');
        } catch {
          return no('网络地址无法确认');
        }
      }
      if (!arg.includes('://') && !arg.startsWith('-') && !localPath(arg))
        return no('命令路径越出项目');
      if (
        arg.includes('=') &&
        !arg.includes('://') &&
        !localPath(arg.slice(arg.indexOf('=') + 1))
      )
        return no('选项中的路径越出项目');
    }
    const first = args[0];
    if (cmd === 'cd' && args.length === 1 && (first === root || first === '.'))
      continue;
    if (
      cmd === 'sleep' &&
      args.length === 1 &&
      /^\d+(?:\.\d+)?$/.test(first) &&
      Number(first) <= 30
    )
      continue;
    if (
      cmd === 'kill' &&
      args.length &&
      args.every((a) => /^%[1-9]\d*$/.test(a))
    )
      continue;
    if (
      cmd === 'rm' &&
      args.length &&
      args.filter((a) => !a.startsWith('-')).length &&
      args.every(
        (a) =>
          ['-f', '--'].includes(a) ||
          /^(?:\.\/)?(?:var\/(?:manual|test-tmp)|tmp)\/[A-Za-z0-9_.*\/-]+$/.test(
            a,
          ),
      )
    )
      continue;
    if (
      cmd === 'mkdir' &&
      args.length &&
      args.every((a) => a === '-p' || !a.startsWith('-'))
    )
      continue;
    if (['ls', 'cat', 'head', 'tail', 'wc', 'echo', 'pwd'].includes(cmd))
      continue;
    if (cmd === 'curl') {
      // No arbitrary config, uploads, proxy, redirects, DNS overrides or external
      // requests. The normal local API methods, data and headers remain usable.
      const flags = new Set([
        '-s',
        '-S',
        '-sS',
        '-f',
        '-i',
        '--fail',
        '--silent',
        '--show-error',
      ]);
      const values = new Set([
        '-X',
        '--request',
        '-H',
        '--header',
        '-d',
        '--data',
        '--data-binary',
        '--max-time',
        '--connect-timeout',
      ]);
      let urls = 0;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (flags.has(a)) continue;
        if (values.has(a)) {
          const value = args[++i];
          if (
            !value ||
            value.startsWith('@') ||
            ((a === '-H' || a === '--header') &&
              /^(?:authorization|proxy-authorization|cookie):/i.test(value))
          )
            return no('请求包含文件上传或认证数据');
          continue;
        }
        try {
          const u = new URL(a);
          if (
            u.protocol !== 'http:' ||
            !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
            u.username ||
            u.password
          )
            return no('只自动确认本机 HTTP 联调');
          urls++;
        } catch {
          return no('curl 选项不在自动确认范围');
        }
      }
      if (urls) continue;
    }
    if (
      ['python', 'python3'].includes(cmd) &&
      ((first === '-m' && /^[A-Za-z_]\w*(?:\.\w+)*$/.test(args[1] || '')) ||
        /^[\w./-]+\.py$/.test(first || '')) &&
      !args.some((a) => ['-c', '--command'].includes(a))
    )
      continue;
    if (
      cmd === 'node' &&
      /^[\w./-]+\.[cm]?js$/.test(first || '') &&
      !args.some((a) => ['-e', '--eval', '-p', '--print'].includes(a))
    )
      continue;
    if (
      ['npm', 'pnpm', 'yarn'].includes(cmd) &&
      (['test', 'build', 'lint', 'typecheck', 'dev', 'start'].includes(first) ||
        (first === 'run' &&
          ['test', 'build', 'lint', 'typecheck', 'dev', 'start'].includes(
            args[1],
          )))
    )
      continue;
    if (cmd === 'go' && ['test', 'build', 'vet'].includes(first)) continue;
    return no('命令不在本地构建、测试和联调白名单：' + cmd);
  }
  return { allowed: true, reason: '当前项目中的本地构建、测试或联调命令' };
}

export function terminalConfirmation(screen, native, directory) {
  const text = compact(screen).slice(-8000);
  const question = text.lastIndexOf('Doyouwanttoproceed?');
  if (
    question < 0 ||
    !text
      .slice(Math.max(0, question - 220), question)
      .includes(
        'Compoundcommandcontainscdwithwriteoperation-manualapprovalrequired',
      ) ||
    !/^Doyouwanttoproceed\?❯1\.Yes2\.Yes,/.test(text.slice(question)) ||
    !/Esctocancel·Tabtoamend·ctrl\+etoexplain$/.test(text)
  )
    return null;
  if (!native || native.complete) return null;
  const events = native.content.split('\n').filter(Boolean).map(JSON.parse);
  const content = events.flatMap((e) =>
    Array.isArray(e.message?.content) ? e.message.content : [],
  );
  const completed = new Set(
    content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id),
  );
  const pending = content.filter(
    (c) => c.type === 'tool_use' && !completed.has(c.id),
  );
  if (
    pending.length !== 1 ||
    pending[0].name !== 'Bash' ||
    typeof pending[0].input?.command !== 'string'
  )
    return null;
  const tool = pending[0];
  return {
    toolUseId: tool.id,
    command: tool.input.command,
    ...localCommandDecision(tool.input.command, directory),
  };
}
