import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSensitiveText } from '../lib/sensitive-content.mjs';

test('credentials, authentication, private keys and contacts redact without returning values', () => {
  const privateKey =
    '-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hp\n-----END PRIVATE KEY-----';
  const text = [
    'API_KEY=ordinary-service-value',
    'password="s3cret!"',
    'Authorization: Bearer abcdefghijklmnop123456',
    'Authorization: Basic dXNlcjpwYXNz',
    'ghp_' + 'a'.repeat(30),
    'contact alice@company.cn +86 13800138000',
    privateKey,
  ].join('\n');
  const result = sanitizeSensitiveText(text);
  for (const value of [
    'ordinary-service-value',
    's3cret!',
    'abcdefghijklmnop123456',
    'dXNlcjpwYXNz',
    'ghp_' + 'a'.repeat(30),
    'alice@company.cn',
    '13800138000',
    'YWJjZGVmZ2hp',
  ])
    assert.ok(!result.text.includes(value));
  assert.equal(result.text.split('\n').length, text.split('\n').length);
  assert.deepEqual(Object.keys(result.findings[0]), ['kind', 'line']);
  assert.equal(result.findings.find((x) => x.kind === 'private-key').line, 7);
  assert.deepEqual(sanitizeSensitiveText(result.text), {
    text: result.text,
    findings: [],
    changed: false,
  });
});

test('explicit placeholders and ordinary business token references are preserved', () => {
  const text = [
    'API_KEY=',
    'API_KEY=YOUR_API_KEY',
    'password="<password>"',
    'token = nextToken',
    'token: "word"',
    'secret = process.env.SECRET',
    'Authorization: Bearer token',
    'user@example.com',
    'const tokenCount = 138;',
  ].join('\n');
  assert.deepEqual(sanitizeSensitiveText(text), {
    text,
    findings: [],
    changed: false,
  });
});

test('explicit known values override placeholder heuristics and truncated private keys fail closed', () => {
  const first = sanitizeSensitiveText('literal SECRET', {
    knownSecrets: ['SECRET'],
  });
  assert.equal(
    sanitizeSensitiveText(first.text, { knownSecrets: ['SECRET'] }).changed,
    false,
  );
  assert.equal(
    sanitizeSensitiveText('password: hunter2\napi_key=unquotedvalue').text,
    'password: [REDACTED_SECRET]\napi_key=[REDACTED_SECRET]',
  );
  assert.equal(
    sanitizeSensitiveText('weak password', { knownSecrets: ['password'] }).text,
    'weak [REDACTED_SECRET]',
  );
  const text = '-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hp';
  assert.equal(sanitizeSensitiveText(text).text, '[REDACTED_SECRET]\n');
});

test('known secret literal, JSON-escaped and URL-encoded forms are handled without altering URL structure', () => {
  const secret = 'alpha"beta/789';
  const json = JSON.stringify({
    nested: { credential: secret },
    url:
      'https://service.test/path?api_key=' +
      encodeURIComponent(secret) +
      '#details',
  });
  const result = sanitizeSensitiveText(json, { knownSecrets: [secret] });
  const value = JSON.parse(result.text);
  assert.equal(value.nested.credential, '[REDACTED_SECRET]');
  const url = new URL(value.url);
  assert.equal(url.pathname, '/path');
  assert.equal(url.hash, '#details');
  assert.equal(url.searchParams.get('api_key'), '[REDACTED_SECRET]');
  assert.equal(
    sanitizeSensitiveText(result.text, { knownSecrets: [secret] }).changed,
    false,
  );
});

test('JSON stays valid for numeric personal data, escaped credentials and multiline private keys', () => {
  const text = JSON.stringify({
    phone: 13800138000,
    password: 123456,
    private:
      '-----BEGIN PRIVATE KEY-----\nYXNkZmFzZGY=\n-----END PRIVATE KEY-----',
    api_key: 'hello"there',
  });
  const result = sanitizeSensitiveText(text);
  const value = JSON.parse(result.text);
  assert.equal(value.phone, '[REDACTED_PHONE]');
  assert.equal(value.password, '[REDACTED_SECRET]');
  assert.equal(value.api_key, '[REDACTED_SECRET]');
  assert.equal(value.private, '[REDACTED_SECRET]');
  assert.equal(sanitizeSensitiveText(result.text).changed, false);
});

test('URLs retain scheme, credential delimiter, query keys and fragments', () => {
  const text =
    'https://user:actual-password@host.test/path?token=abc123456789xyz&email=alice@company.cn#section';
  const result = sanitizeSensitiveText(text);
  const url = new URL(result.text);
  assert.equal(url.hostname, 'host.test');
  assert.equal(url.pathname, '/path');
  assert.equal(url.hash, '#section');
  assert.equal(url.username, 'user');
  assert.equal(decodeURIComponent(url.password), '[REDACTED_SECRET]');
  assert.equal(url.searchParams.get('token'), '[REDACTED_SECRET]');
  assert.equal(url.searchParams.get('email'), '[REDACTED_EMAIL]');
});

test('JSON embedded commands and escaped quotes redact without consuming structural bytes', () => {
  const text = JSON.stringify(
    {
      message:
        'curl --data \'{"api_key":"live-fixture-value","password":"p\\"q"}\' https://service.test',
      api_key: 'value"with\\escapes',
      nested: [{ password: 123456 }, { value: 'hello\nworld' }],
    },
    null,
    2,
  );
  const result = sanitizeSensitiveText(text);
  const value = JSON.parse(result.text);
  assert.equal(value.api_key, '[REDACTED_SECRET]');
  assert.equal(value.nested[0].password, '[REDACTED_SECRET]');
  assert.equal(value.nested[1].value, 'hello\nworld');
  assert.ok(!result.text.includes('live-fixture-value'));
  assert.equal(sanitizeSensitiveText(result.text).changed, false);
  assert.equal(result.text.split('\n').length, text.split('\n').length);
});

test('untouched JSON tokens preserve number precision, escapes and whitespace', () => {
  const text =
    '{ "count": 99999999999999999999, "duration": 0.13800138000, "name": "\\u4e2d", "values": [true, false, null] }';
  assert.deepEqual(sanitizeSensitiveText(text), {
    text,
    findings: [],
    changed: false,
  });
});
