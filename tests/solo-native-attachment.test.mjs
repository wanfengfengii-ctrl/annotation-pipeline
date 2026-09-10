import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { evidenceInventory } from '../scripts/evidence.mjs';
import { digest } from '../scripts/solo-records.mjs';
import {
  createSoloNativeAttachment,
  assertPreparedNativeAttachment,
  soloNativeAttachmentVersion,
} from '../scripts/solo-native-attachment.mjs';
import { resolveSoloNativeIdentity } from '../scripts/solo-native-identity.mjs';

function fixture(t, { denied = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-native-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'final', 'projects');
  fs.mkdirSync(path.join(root, '-workspace', 'session', 'subagents'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, '-workspace', 'empty'));
  const secret = 'private-fixture-credential-12345';
  const events = [
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
    {
      type: 'user',
      sessionId: 'session',
      uuid: 'message-uuid',
      promptId: 'prompt',
      message: { content: 'Build a page' },
    },
    {
      type: 'assistant',
      sessionId: 'session',
      uuid: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool',
            name: 'Bash',
            input: { command: 'test' },
          },
        ],
      },
    },
    {
      type: 'user',
      sessionId: 'session',
      uuid: 'result',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool',
            is_error: denied,
            content: denied ? 'Permission to use Bash has been denied' : secret,
          },
        ],
      },
    },
  ];
  const main = path.join(root, '-workspace', 'session.jsonl');
  fs.writeFileSync(
    main,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(root, '-workspace', 'session', 'subagents', 'agent.jsonl'),
    JSON.stringify({
      type: 'assistant',
      sessionId: 'session',
      uuid: 'subagent',
      message: { content: 'done' },
    }) + '\n',
  );
  // None of these internal files may enter the external trace ZIP.
  fs.writeFileSync(path.join(dir, 'evaluation.json'), '{"score":5}');
  fs.writeFileSync(path.join(dir, 'pipeline.jsonl'), '{"stage":"score"}\n');
  const manifestPath = path.join(dir, 'final', 'manifest.json');
  const refresh = () => {
    const inventory = evidenceInventory(root);
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ containerId: 'container', files: inventory.files }),
    );
    return {
      verified: true,
      path: root,
      manifestPath,
      files: inventory.files.length,
      sha256: digest(inventory.files),
    };
  };
  return {
    dir,
    root,
    main,
    refresh,
    options: {
      dir,
      turnId: 'turn',
      traceExport: refresh(),
      containerId: 'container',
      sessionId: 'session',
      promptId: 'prompt',
      knownSecrets: [secret],
    },
  };
}

test('SOLO ZIP only contains complete native directories; audit remains local and original bytes stay intact', (t) => {
  const f = fixture(t),
    original = fs.readFileSync(f.main);
  const attachment = createSoloNativeAttachment(f.options);
  const zip = unzipSync(attachment.bytes);
  assert.deepEqual(
    Object.keys(zip).sort(),
    [
      'projects/-workspace/',
      'projects/-workspace/empty/',
      'projects/-workspace/session/',
      'projects/-workspace/session/subagents/',
      'projects/-workspace/session/subagents/agent.jsonl',
      'projects/-workspace/session.jsonl',
    ].sort(),
  );
  assert.deepEqual(
    Buffer.from(zip['projects/-workspace/session.jsonl']),
    original,
  );
  const events = Buffer.from(zip['projects/-workspace/session.jsonl'])
    .toString()
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(events.length, 4);
  assert.equal(events[1].uuid, 'message-uuid');
  assert.equal(events[1].promptId, 'prompt');
  assert.equal(events[1].sessionId, 'session');
  assert.deepEqual(fs.readFileSync(f.main), original);
  assert.ok(fs.existsSync(attachment.path + '.audit.json'));
  const audit = JSON.parse(fs.readFileSync(attachment.path + '.audit.json'));
  assert.equal(audit.policyVersion, soloNativeAttachmentVersion);
  assert.equal(audit.byteIdentical, true);
  assert.equal(audit.redactions, 0);
  assert.ok(
    audit.files.every(
      (file) =>
        file.byteIdentical &&
        file.redactions === 0 &&
        file.sha256 === file.originalSha256,
    ),
  );
  assert.equal(createSoloNativeAttachment(f.options).sha256, attachment.sha256);
});

test('native bytes and names preserve normal Basic text, credential-like fixtures, BOM, CRLF and JSON whitespace', (t) => {
  const f = fixture(t);
  const original =
    '\uFEFF' +
    fs.readFileSync(f.main, 'utf8').replaceAll('\n', '\r\n') +
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'thinking',
            thinking:
              'basic parameters; basic structure; basic functions; basic specifications',
          },
          {
            type: 'text',
            text: '--password-store=basic --use-mock-keychain; Bearer synthetic-fixture-token-12345; password=fixture123; test@fictional-company.dev',
          },
        ],
      },
    }) +
    '\r\n\r\n';
  fs.writeFileSync(f.main, original);
  const nativeName = 'test@fictional-company.dev.json';
  const json =
    '\uFEFF{ "password": "fixture123", "note": "保持原文和空格" }\r\n';
  fs.writeFileSync(path.join(f.root, nativeName), json);
  const archive = createSoloNativeAttachment({
    ...f.options,
    traceExport: f.refresh(),
  });
  const zip = unzipSync(archive.bytes);
  assert.deepEqual(
    Buffer.from(zip['projects/-workspace/session.jsonl']),
    Buffer.from(original),
  );
  assert.deepEqual(
    Buffer.from(zip['projects/' + nativeName]),
    Buffer.from(json),
  );
  assert.deepEqual(fs.readFileSync(f.main), Buffer.from(original));
});

test('send check rejects legacy redaction ZIPs, replaced files and unverified builders', (t) => {
  const f = fixture(t);
  const archive = createSoloNativeAttachment(f.options);
  const prepared = {
    path: archive.path,
    name: archive.name,
    sha256: archive.sha256,
    bytes: archive.bytes.length,
  };
  assert.doesNotThrow(() => assertPreparedNativeAttachment(archive, prepared));
  const zip = unzipSync(archive.bytes);
  zip['projects/-workspace/session.jsonl'] = Buffer.from(
    Buffer.from(zip['projects/-workspace/session.jsonl'])
      .toString()
      .replace(f.options.knownSecrets[0], '[REDACTED_SECRET]'),
  );
  const legacyBytes = Buffer.from(zipSync(zip));
  const legacyPath = path.join(f.dir, 'legacy.zip');
  fs.writeFileSync(legacyPath, legacyBytes);
  assert.throws(
    () =>
      assertPreparedNativeAttachment(archive, {
        path: legacyPath,
        name: 'legacy.zip',
        sha256: digest(legacyBytes),
        bytes: legacyBytes.length,
      }),
    /禁止上传替换版/,
  );
  assert.throws(
    () =>
      assertPreparedNativeAttachment(
        { ...archive, byteIdentical: false },
        prepared,
      ),
    /禁止上传替换版/,
  );
  fs.writeFileSync(archive.path, legacyBytes);
  assert.throws(
    () => assertPreparedNativeAttachment(archive, prepared),
    /禁止上传替换版/,
  );
});

test('native attachment rejects changed originals, wrong identity and oversized ZIP', (t) => {
  const f = fixture(t);
  assert.throws(
    () => createSoloNativeAttachment({ ...f.options, promptId: 'wrong' }),
    /找不到本轮/,
  );
  assert.throws(
    () =>
      createSoloNativeAttachment({ ...f.options, promptId: 'message-uuid' }),
    /找不到本轮/,
  );
  assert.throws(
    () => createSoloNativeAttachment({ ...f.options, containerId: 'wrong' }),
    /容器身份/,
  );
  assert.throws(
    () => createSoloNativeAttachment({ ...f.options, maxBytes: 1 }),
    /大小上限/,
  );
  fs.appendFileSync(f.main, '\n');
  assert.throws(() => createSoloNativeAttachment(f.options), /大小或摘要不符/);
});

test('SOLO resolves promptId from the exact user event, never from message UUID or a different round', (t) => {
  const f = fixture(t);
  const options = { ...f.options, messageUuid: 'message-uuid' };
  const identity = resolveSoloNativeIdentity(options);
  assert.equal(identity.promptId, 'prompt');
  assert.equal(identity.messageUuid, 'message-uuid');
  assert.equal(identity.line, 2);
  assert.throws(
    () => resolveSoloNativeIdentity({ ...options, messageUuid: 'result' }),
    /唯一定位/,
  );
  assert.throws(
    () => resolveSoloNativeIdentity({ ...options, sessionId: 'other' }),
    /唯一定位/,
  );
  const text = fs
    .readFileSync(f.main, 'utf8')
    .replace(',"promptId":"prompt"', '');
  fs.writeFileSync(f.main, text);
  assert.throws(
    () => resolveSoloNativeIdentity({ ...options, traceExport: f.refresh() }),
    /不能用消息 UUID/,
  );
});

test('permission denials and unsupported native files are not silently omitted', (t) => {
  const denied = fixture(t, { denied: true });
  assert.throws(
    () => createSoloNativeAttachment(denied.options),
    /权限核验未通过/,
  );
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'unknown.bin'), 'unverified');
  assert.throws(
    () =>
      createSoloNativeAttachment({ ...f.options, traceExport: f.refresh() }),
    /非 JSON/,
  );
});
