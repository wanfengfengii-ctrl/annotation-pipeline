import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rules,
  policyInstructions,
  candidateDigest,
  assertPolicyAudit,
} from '../lib/task-policy.mjs';
import {
  githubRepository,
  githubSnapshot,
} from '../scripts/github-snapshot.mjs';
test('policy covers every source family and rejects missing, stale, mismatched or contradictory audits', async () => {
  const digest = await candidateDigest({ title: 'target', prompt: 'goal' });
  const audit = {
    engine: 'codex-cli',
    ruleVersion: rules.version,
    candidateDigest: digest,
    tracePath: '/trace',
    threadId: 'thread',
    value: {
      allowed: true,
      matchedRuleIds: [],
      duplicateTaskIds: [],
      checkedGroups: rules.groups.map((g) => g.id),
      reason: 'eligible',
    },
  };
  assert.doesNotThrow(() => assertPolicyAudit(audit, digest));
  for (const patch of [
    { ruleVersion: 'old' },
    { candidateDigest: 'different' },
    { value: { ...audit.value, allowed: false } },
    { value: { ...audit.value, matchedRuleIds: ['games'] } },
    { value: { ...audit.value, checkedGroups: ['games'] } },
    { value: { ...audit.value, duplicateTaskIds: ['existing'] } },
  ])
    assert.throws(() => assertPolicyAudit({ ...audit, ...patch }, digest));
  for (const term of [
    '2048',
    'CLI',
    'RBAC',
    'CSV',
    'Todo',
    '音乐播放器',
    '喂食小动物',
  ])
    assert.ok(policyInstructions().includes(term));
  assert.notEqual(
    digest,
    await candidateDigest({ title: 'target', prompt: 'changed' }),
  );
});
test('GitHub CLI snapshot verifies dirty state, exact remote SHA, URLs and preserves first snapshot', () => {
  const sha = 'a'.repeat(40),
    url = 'https://github.com/acme/repo';
  const command = (cmd, args) => {
    if (cmd === 'git')
      return args[0] === 'rev-parse'
        ? sha
        : args[0] === 'remote'
          ? 'git@github.com:acme/repo.git'
          : '';
    return JSON.stringify(
      args[0] === 'repo'
        ? {
            nameWithOwner: 'acme/repo',
            url,
            isPrivate: true,
            viewerPermission: 'READ',
          }
        : { sha, html_url: url + '/commit/' + sha },
    );
  };
  assert.equal(
    githubRepository('ssh://git@github.com/acme/repo.git'),
    'acme/repo',
  );
  assert.throws(() => githubRepository('https://evil.example/acme/repo'));
  const s = githubSnapshot('/repo', { command });
  assert.equal(s.url, url + '/commit/' + sha);
  assert.equal(s.isPrivate, true);
  assert.match(s.accessNote, /未验证其他/);
  assert.throws(
    () =>
      githubSnapshot('/repo', {
        command: (cmd, a) =>
          cmd === 'git' && a[0] === 'status' ? ' M file' : command(cmd, a),
      }),
    /未提交/,
  );
  assert.throws(
    () => githubSnapshot('/repo', { expectedSha: 'b'.repeat(40), command }),
    /HEAD 已变化/,
  );
  assert.throws(
    () =>
      githubSnapshot('/repo', {
        command: (cmd, a) =>
          cmd === 'gh' && a[0] === 'api'
            ? JSON.stringify({
                sha: 'b'.repeat(40),
                html_url: url + '/commit/' + sha,
              })
            : command(cmd, a),
      }),
    /不一致/,
  );
  const preserved = githubSnapshot('/repo', {
    existingSnapshot: s.url,
    command: (cmd, a) =>
      cmd === 'git' && a[0] === 'rev-parse' ? 'b'.repeat(40) : command(cmd, a),
  });
  assert.equal(preserved.sha, sha);
});
