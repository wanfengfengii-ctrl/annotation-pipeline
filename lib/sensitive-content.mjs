export const sensitiveContentVersion = '2026-09-10.sensitive2';

const markers = {
  email: '[REDACTED_EMAIL]',
  phone: '[REDACTED_PHONE]',
  secret: '[REDACTED_SECRET]',
};
const placeholder = (value) =>
  !value ||
  /^\[REDACTED_(?:SECRET|EMAIL|PHONE)\]$/.test(value) ||
  /^(?:null|undefined|none|true|false|example|sample|dummy|test|token|secret|password|api[_-]?key|changeme|redacted|masked|replace[_-]?me|your[_-][\w-]+|<[^<>\r\n]+>|\$\{[^}\r\n]+\}|\$[A-Za-z_][\w]*|\*+|x{3,}|\.{3,})$/i.test(
    value,
  );
const credentialKey = (key) =>
  /^(?:[\w.-]*[_-])?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|token|secret)$/i.test(
    key,
  );

// This is a bounded detector for common credentials and contact details, not
// a claim that arbitrary unknown personal information can be recognized.
function sanitizeUnstructuredText(
  text,
  { knownSecrets = [], credential, preserveLines = true } = {},
) {
  if (typeof text !== 'string') throw Error('敏感检查输入必须为文本');
  const spans = [];
  const protectedSpans = [
    ...text.matchAll(/\[REDACTED_(?:SECRET|EMAIL|PHONE)\]/g),
  ].map((m) => [m.index, m.index + m[0].length]);
  const add = (start, end, kind) => {
    if (protectedSpans.some(([left, right]) => start >= left && end <= right))
      return;
    if (end > start) spans.push({ start, end, kind });
  };
  const match = (pattern, kind, select = (m) => [m.index, m[0].length]) => {
    for (const m of text.matchAll(pattern)) {
      const found = select(m);
      if (found) add(found[0], found[0] + found[1], kind);
    }
  };
  if (
    credentialKey(credential || '') &&
    !placeholder(text) &&
    (!/^(?:token|secret)$/i.test(credential) ||
      (text.length >= 12 && /[A-Za-z]/.test(text) && /[0-9_+/-]/.test(text)))
  )
    add(0, text.length, 'credential-assignment');
  for (const secret of new Set(knownSecrets)) {
    if (
      typeof secret !== 'string' ||
      !secret ||
      /^\[REDACTED_(?:SECRET|EMAIL|PHONE)\]$/.test(secret)
    )
      continue;
    for (const value of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])) {
      let start = 0;
      while ((start = text.indexOf(value, start)) !== -1) {
        add(start, start + value.length, 'known-secret');
        start += value.length;
      }
    }
  }
  match(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|$)/g,
    'private-key',
  );
  match(
    /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,})\b/g,
    'provider-token',
  );
  match(
    /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/-]+=*)/gi,
    'authorization',
    (m) => {
      const value = m[1];
      if (
        placeholder(value) ||
        /^(?:authentication|authorization|scheme|credentials)$/i.test(value)
      )
        return null;
      return [m.index + m[0].length - value.length, value.length];
    },
  );
  match(
    /(?<![\w.-])(["']?)((?:[\w.-]{0,79}[_-])?(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|token|secret))\1[ \t]*[:=][ \t]*("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;&<>{}()[\]"'`]{1,512})/gi,
    'credential-assignment',
    (m) => {
      const key = m[2],
        raw = m[3];
      if (!credentialKey(key)) return null;
      const quoted = raw[0] === '"' || raw[0] === "'";
      const value = quoted ? raw.slice(1, -1) : raw;
      if (placeholder(value)) return null;
      // Generic business token variables and explicit property references are
      // not their secret values. Strong password/API-key fields are literals.
      const query = /[?&]$/.test(text.slice(Math.max(0, m.index - 1), m.index));
      if (
        !quoted &&
        !query &&
        key !== key.toUpperCase() &&
        (/^[A-Za-z_$][\w.$]*\.[\w.$]+$/.test(value) ||
          (/^(?:token|secret)$/i.test(key) && /^[A-Za-z_$][\w$]*$/.test(value)))
      )
        return null;
      if (
        /^(?:token|secret)$/i.test(key) &&
        !query &&
        !(
          value.length >= 12 &&
          /[A-Za-z]/.test(value) &&
          /[0-9_+/-]/.test(value)
        )
      )
        return null;
      const start = m.index + m[0].length - raw.length + Number(quoted);
      return [start, query ? value.split('#')[0].length : value.length];
    },
  );
  match(
    /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:([^@\s/]+)@/gi,
    'url-credential',
    (m) =>
      placeholder(m[1])
        ? null
        : [m.index + m[0].lastIndexOf(m[1] + '@'), m[1].length],
  );
  match(
    /(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}(?![\w.-])/g,
    'email',
    (m) =>
      /@(?:[^@.]+\.)*(?:example\.(?:com|net|org)|invalid|test)$/i.test(m[0])
        ? null
        : [m.index, m[0].length],
  );
  match(/(?<![\w.])(?:\+?86[ -]?)?1[3-9]\d{9}(?![\w.]|[eE][+-]?\d)/g, 'phone');
  match(/(?<![\w])\+[1-9]\d(?:[ ().-]*\d){7,13}(?![\w])/g, 'phone');

  const merged = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
      if (
        ['email', 'phone'].includes(last.kind) &&
        !['email', 'phone'].includes(span.kind)
      )
        last.kind = span.kind;
    } else merged.push({ ...span });
  }
  let output = '',
    cursor = 0;
  const findings = [];
  for (const span of merged) {
    let replacement = markers[span.kind] || markers.secret;
    if (preserveLines)
      replacement += (
        text.slice(span.start, span.end).match(/\r\n|\r|\n/g) || []
      ).join('');
    output += text.slice(cursor, span.start) + replacement;
    findings.push({
      kind: span.kind,
      line: 1 + (text.slice(0, span.start).match(/\n/g) || []).length,
    });
    cursor = span.end;
  }
  output += text.slice(cursor);
  return { text: output, findings, changed: output !== text };
}

// Scan decoded JSON scalar tokens, then escape only replacements. Running text
// regexes over serialized JSON can consume a closing quote or half an escape.
// Untouched tokens, whitespace, key order and number precision stay unchanged.
export function sanitizeSensitiveText(text, options = {}) {
  if (typeof text !== 'string') throw Error('敏感检查输入必须为文本');
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return sanitizeUnstructuredText(text, options);
  }
  const findings = [];
  let output = '',
    cursor = 0,
    key,
    keyEnd = -1,
    line = 1;
  const tokens =
    /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
  for (const token of text.matchAll(tokens)) {
    const start = token.index,
      end = start + token[0].length;
    const isString = token[0][0] === '"';
    const value = isString ? JSON.parse(token[0]) : token[0];
    const isKey = isString && /^\s*:/.test(text.slice(end));
    const credential =
      !isKey && /^\s*:\s*$/.test(text.slice(keyEnd, start)) ? key : undefined;
    const result = sanitizeUnstructuredText(value, {
      ...options,
      credential,
      preserveLines: false,
    });
    const gap = text.slice(cursor, start);
    output += gap + (result.changed ? JSON.stringify(result.text) : token[0]);
    line += (gap.match(/\n/g) || []).length;
    findings.push(...result.findings.map(({ kind }) => ({ kind, line })));
    cursor = end;
    if (isKey) {
      key = value;
      keyEnd = end;
    }
  }
  output += text.slice(cursor);
  JSON.parse(output.replace(/^\uFEFF/, ''));
  return { text: output, findings, changed: output !== text };
}
