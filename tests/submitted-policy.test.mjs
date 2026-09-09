import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fixture from './fixtures/question.cjs';
import { candidateDigest, rules } from '../lib/task-policy.mjs';
import { questionRules } from '../lib/question-writing.mjs';
import { auditPermissionTraces } from '../lib/permission-audit.mjs';
import {
  submittedPolicyEvidence,
  submittedPolicyInstructions,
  assertSubmittedPolicyDeliverable,
} from '../scripts/submitted-policy.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonl = (events) =>
  events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const sessionId = '00000000-0000-4000-8000-000000000001';
const turnId = '00000000-0000-4000-8000-000000000002';
const promptId = '00000000-0000-4000-8000-000000000003';

async function setup(t, { dispute = true } = {}) {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'submitted-policy-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'task');
  mkdirSync(dir);
  const candidate = {
    title: 'Existing project',
    prompt: fixture.repair(),
    category: 'Bug 修复',
    difficulty: '中等',
    repoPath: path.join(dir, 'workspace'),
  };
  const value = {
    ...fixture.questionAudit,
    allowed: true,
    assessedDifficulty: '中等',
    simpleFeatures: [],
    difficultyEvidence: ['scope', 'context', 'interaction', 'breadth'],
    followupFix: true,
    followupReason: 'Verified preceding defects',
    matchedRuleIds: [],
    duplicateTaskIds: [],
    checkedGroups: rules.groups.map((group) => group.id),
    reason: 'Passed before sending',
  };
  const writeAudit = (attempt, auditValue, at = '2020-01-01T00:03:00Z') => {
    const outputPath = path.join(
      dir,
      `${turnId}.attempt-${attempt}.policy.json`,
    );
    const tracePath = outputPath.replace(/\.json$/, '.events.jsonl');
    writeFileSync(outputPath, JSON.stringify(auditValue));
    writeFileSync(
      tracePath,
      jsonl([
        { type: 'thread.started', thread_id: 'codex-' + attempt },
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(auditValue) },
        },
        { type: 'turn.completed' },
      ]),
    );
    utimesSync(outputPath, new Date(at), new Date(at));
    utimesSync(tracePath, new Date(at), new Date(at));
    return { outputPath, tracePath };
  };
  const first = writeAudit(2, value, '2020-01-01T00:00:00Z');
  const original = {
    value,
    engine: 'codex-cli',
    accepted: true,
    ruleVersion: rules.version,
    questionRuleVersion: questionRules.version,
    candidateDigest: await candidateDigest(candidate),
    tracePath: first.tracePath,
    threadId: 'codex-2',
    finishedAt: '2020-01-01T00:00:01Z',
    roundContext: { firstTurn: false, allowFollowupFix: true },
  };
  const refused = {
    ...value,
    allowed: false,
    questionCompliant: false,
    reason:
      'The prompt says slider while the original evidence clicked a time button',
  };
  const post = dispute ? writeAudit(3, refused) : null;
  const round = [
    {
      type: 'user',
      uuid: promptId,
      sessionId,
      timestamp: '2020-01-01T00:01:00Z',
      message: { content: candidate.prompt },
    },
    {
      type: 'assistant',
      uuid: 'assistant',
      sessionId,
      message: {
        content: [{ type: 'text', text: 'Completed the requested changes' }],
      },
    },
    {
      type: 'system',
      subtype: 'turn_duration',
      sessionId,
      timestamp: '2020-01-01T00:02:00Z',
    },
  ];
  const native = jsonl([
    { type: 'permission-mode', permissionMode: 'bypassPermissions' },
    ...round,
  ]);
  const exportDir = path.join(dir, 'native-export');
  const projects = path.join(exportDir, 'projects');
  mkdirSync(path.join(projects, '-workspace'), { recursive: true });
  const name = '-workspace/' + sessionId + '.jsonl';
  const nativePath = path.join(projects, name);
  writeFileSync(nativePath, native);
  const files = [
    { name, bytes: Buffer.byteLength(native), sha256: hash(native) },
  ];
  const manifestPath = path.join(exportDir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ containerId: 'container', files }),
  );
  const tracePath = path.join(dir, turnId + '.jsonl');
  writeFileSync(tracePath, jsonl(round));
  const traceSha256 = hash(JSON.stringify(files));
  const cached = {
    prepare: { value: { ...candidate } },
    policy: original,
    claude: {
      success: true,
      executionOutcome: 'complete',
      finishedAt: '2020-01-01T00:02:01Z',
      sessionId,
      promptId,
      container: { containerId: 'container' },
      tracePath,
      traceExport: {
        verified: true,
        path: projects,
        manifestPath,
        files: 1,
        sha256: traceSha256,
      },
      permissionAudit: {
        ...auditPermissionTraces([{ name, content: native }]),
        traceSha256,
      },
    },
  };
  return {
    dir,
    turnId,
    cached,
    candidate,
    original,
    refused,
    first,
    post,
    nativePath,
    manifestPath,
    writeAudit,
    read: () => submittedPolicyEvidence({ dir, turnId, cached, candidate }),
  };
}

test('collects bound original approval and later factual rejection without approving delivery or changing inputs', async (t) => {
  const f = await setup(t);
  const original = structuredClone({
    cached: f.cached,
    candidate: f.candidate,
  });
  const native = readFileSync(f.nativePath);
  const evidence = await f.read();
  assert.equal(evidence.receipt.promptId, promptId);
  assert.equal(evidence.receipt.candidateDigest, f.original.candidateDigest);
  assert.equal(evidence.originalPolicy.value.allowed, true);
  assert.equal(evidence.postExecutionPolicy[0].value.allowed, false);
  assert.equal(evidence.postExecutionPolicy[0].threadId, 'codex-3');
  assert.equal(
    evidence.postExecutionPolicy[0].outputSha256,
    hash(readFileSync(f.post.outputPath)),
  );
  assert.deepEqual({ cached: f.cached, candidate: f.candidate }, original);
  assert.deepEqual(readFileSync(f.nativePath), native);
  assert.throws(() => assertSubmittedPolicyDeliverable(evidence), /仍审核失败/);
  assert.match(
    submittedPolicyInstructions(evidence),
    /不把出题错误归因于 Claude/,
  );
  assert.match(submittedPolicyInstructions(evidence), /禁止自动续题/);
});

test('no post-execution dispute returns null and earlier rejected unsent draft does not trigger collection', async (t) => {
  const f = await setup(t, { dispute: false });
  f.writeAudit(1, f.refused, '2019-12-31T23:59:00Z');
  assert.equal(await f.read(), null);
  assert.doesNotThrow(() => assertSubmittedPolicyDeliverable(null));
  assert.equal(submittedPolicyInstructions(null), '');
});

test('legacy style not applicable is not mistaken for a factual rejection', async (t) => {
  const f = await setup(t, { dispute: false });
  delete f.cached.policy.questionRuleVersion;
  f.writeAudit(3, {
    ...f.original.value,
    allowed: true,
    questionCompliant: false,
  });
  assert.equal(await f.read(), null);
});

test('an existing dispute cannot fall back to fresh execution if its success receipt changes', async (t) => {
  const f = await setup(t);
  f.cached.submittedPolicyEvidence = await f.read();
  f.cached.claude.success = false;
  await assert.rejects(f.read, /不能回退重新执行/);
});

test('a later policy approval cannot erase an already recorded rejection', async (t) => {
  const f = await setup(t);
  f.writeAudit(4, f.original.value, '2020-01-01T00:04:00Z');
  const evidence = await f.read();
  assert.equal(evidence.postExecutionPolicy.length, 2);
  assert.equal(evidence.postExecutionPolicy[1].value.allowed, true);
  assert.throws(
    () => assertSubmittedPolicyDeliverable(evidence),
    /禁止自动续题/,
  );
  f.cached.submittedPolicyEvidence = evidence;
  f.cached.policy = { value: f.refused, accepted: false };
  assert.equal((await f.read()).originalPolicy.value.allowed, true);
});

for (const [label, change, pattern] of [
  [
    'prompt',
    (f) => {
      f.candidate.prompt += ' changed';
    },
    /准备记录/,
  ],
  [
    'category',
    (f) => {
      f.candidate.category = 'Feature 迭代';
    },
    /准备记录/,
  ],
  [
    'difficulty',
    (f) => {
      f.candidate.difficulty = '简单';
    },
    /准备记录/,
  ],
  [
    'workspace',
    (f) => {
      f.candidate.repoPath += '/other';
    },
    /候选摘要/,
  ],
  [
    'title',
    (f) => {
      f.candidate.title += ' other';
    },
    /候选摘要/,
  ],
  [
    'digest',
    (f) => {
      f.cached.policy.candidateDigest = 'a'.repeat(64);
    },
    /候选摘要/,
  ],
  [
    'original approval',
    (f) => {
      f.cached.policy.accepted = false;
    },
    /发送前/,
  ],
  [
    'session',
    (f) => {
      f.cached.claude.sessionId = 'another';
    },
    /会话回执/,
  ],
  [
    'native prompt id',
    (f) => {
      f.cached.claude.promptId = 'another';
    },
    /回执缺失/,
  ],
  [
    'container',
    (f) => {
      f.cached.claude.container.containerId = 'another';
    },
    /manifest/,
  ],
  [
    'completion',
    (f) => {
      f.cached.claude.executionOutcome = 'truncated';
    },
    /完整成功/,
  ],
  [
    'audit order',
    (f) => {
      f.cached.policy.finishedAt = '2020-01-01T00:01:30Z';
    },
    /时间顺序/,
  ],
]) {
  test('disputed collection rejects changed ' + label, async (t) => {
    const f = await setup(t);
    change(f);
    await assert.rejects(f.read, pattern);
  });
}

test('recomputes manifest and native hashes, and verifies current turn excerpt', async (t) => {
  const f = await setup(t);
  const bytes = readFileSync(f.nativePath);
  writeFileSync(f.nativePath, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(f.read, /轨迹文件摘要/);
  writeFileSync(f.nativePath, bytes);
  writeFileSync(f.cached.claude.tracePath, 'changed\n');
  await assert.rejects(f.read, /本轮轨迹/);
});

test('policy output requires matching completed Codex event and thread', async (t) => {
  const f = await setup(t);
  const original = readFileSync(f.post.tracePath, 'utf8');
  writeFileSync(
    f.post.tracePath,
    original.replace('turn.completed', 'turn.failed'),
  );
  await assert.rejects(f.read, /事件证据/);
  writeFileSync(f.post.tracePath, original);
  f.cached.policy.threadId = 'other';
  await assert.rejects(f.read, /事件证据/);
});

test('a saved dispute cannot be erased by changing output, removing it, or changing the original approval', async (t) => {
  const f = await setup(t);
  f.cached.submittedPolicyEvidence = await f.read();
  f.writeAudit(3, f.original.value);
  await assert.rejects(f.read, /拒绝证据缺失|既有后置审核证据/);
  f.writeAudit(3, f.refused);
  const evidence = await f.read();
  f.cached.submittedPolicyEvidence = evidence;
  rmSync(f.post.outputPath);
  await assert.rejects(f.read, /拒绝证据缺失/);
});

test('rejects symlinked policy evidence even inside the task directory', async (t) => {
  const f = await setup(t);
  const moved = path.join(f.dir, 'moved.json');
  writeFileSync(moved, readFileSync(f.post.outputPath));
  rmSync(f.post.outputPath);
  symlinkSync(moved, f.post.outputPath);
  await assert.rejects(f.read, /符号链接/);
});

test('a cached success without the native duration receipt cannot collect disputed results', async (t) => {
  const f = await setup(t);
  const native =
    readFileSync(f.nativePath, 'utf8')
      .split('\n')
      .filter((line) => line && JSON.parse(line).subtype !== 'turn_duration')
      .join('\n') + '\n';
  writeFileSync(f.nativePath, native);
  const manifest = JSON.parse(readFileSync(f.manifestPath));
  manifest.files[0] = {
    ...manifest.files[0],
    bytes: Buffer.byteLength(native),
    sha256: hash(native),
  };
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  f.cached.claude.traceExport.sha256 = hash(JSON.stringify(manifest.files));
  f.cached.claude.permissionAudit.traceSha256 =
    f.cached.claude.traceExport.sha256;
  await assert.rejects(f.read, /原生本轮未完整结束/);
});
