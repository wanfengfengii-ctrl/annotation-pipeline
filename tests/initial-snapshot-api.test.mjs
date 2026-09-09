// Synthetic snapshots only: isolated port 3001, no model or GitHub calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { api, base } from './fixtures/flow-helper.mjs';
import {
  containerImage,
  containerPolicyVersion,
  dockerSnapshot,
} from '../lib/container-policy.mjs';
import { initialCodeVersion } from '../lib/initial-code-snapshot.mjs';
assert.equal(new URL(base).port, '3001');
const token = readFileSync('.dev.vars', 'utf8').match(
  /^RUNNER_TOKEN=(.+)$/m,
)[1];
const call = async (body) => {
  const response = await fetch(base + '/api/runner', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
};
const run = async (body) => {
  const r = await call(body);
  assert.equal(r.status, 200, JSON.stringify(r.value));
  return r.value;
};
const created = await api('/api/tasks', {
  title: '__INITIAL_SNAPSHOT_TEST__',
  repoPath: '/tmp/snapshot-fixture',
  stack: 'fixture',
  category: 'Feature 迭代',
  difficulty: '中等',
  reproducibility: '无外部依赖',
  projectSeries: false,
  autoStart: true,
});
const taskId = created.task.id;
const latest = async () =>
  (await api('/api/tasks', null, 'GET')).tasks.find((t) => t.id === taskId);
{
  const { job } = await run({ action: 'claim', capacity: 1 });
  assert.equal(job.task.id, taskId);
  const questionId = job.turn.id;
  const old = {
    taskId,
    questionId: randomUUID(),
    name: 'annotation-' + taskId,
    containerId: 'old',
    image: containerImage,
    imageId: 'sha256:' + 'a'.repeat(64),
    snapshot: dockerSnapshot('sha256:' + 'a'.repeat(64)),
    policyVersion: containerPolicyVersion,
    status: 'running',
    workDir: '/fixture/old/workspace',
    sourceSnapshot: {
      manifestPath: '/fixture/old/manifest.json',
      sha256: 'b'.repeat(64),
      files: 19,
    },
  };
  await run({ action: 'container', taskId, container: old });
  await run({
    action: 'finish',
    taskId,
    turnId: questionId,
    jobToken: job.turn.jobToken,
    success: false,
    stage: 'context',
    error: 'synthetic close failure',
    container: old,
    traceExport: { verified: true },
    permissionAudit: { passed: true },
  });
  const failed = await latest();
  assert.equal(failed.turns[0].container, undefined);
  assert.equal(failed.turns[0].traceExport, undefined);
  assert.equal(failed.turns[0].permissionAudit, undefined);
  assert.equal(failed.container.questionId, old.questionId);
  await api(
    '/api/tasks/' + taskId,
    { action: 'retry', turnId: questionId, revision: failed.revision },
    'PATCH',
  );
  const retry = (await run({ action: 'claim', capacity: 1 })).job;
  const current = {
    ...old,
    questionId,
    containerId: 'current',
    workDir: '/fixture/current/workspace',
    sourceSnapshot: {
      manifestPath: '/fixture/current/manifest.json',
      sha256: 'c'.repeat(64),
      files: 21,
    },
  };
  await run({ action: 'container', taskId, container: current });
  const snapshot = {
    version: initialCodeVersion,
    engine: 'github-cli-initial-code',
    taskId,
    questionId,
    manifestSha256: current.sourceSnapshot.sha256,
    imageSnapshot: current.snapshot,
    sha: 'd'.repeat(40),
    tree: 'e'.repeat(40),
    repository: 'fixture/snapshot',
    url: 'https://github.com/fixture/snapshot/commit/' + 'd'.repeat(40),
    isPrivate: true,
    files: 21,
    publicationMode: 'before-run',
    verifiedAt: new Date().toISOString(),
  };
  await run({ action: 'initial-code-snapshot', taskId, questionId, snapshot });
  await run({ action: 'initial-code-snapshot', taskId, questionId, snapshot });
  const wrong = {
    ...snapshot,
    sha: 'f'.repeat(40),
    url: 'https://github.com/fixture/snapshot/commit/' + 'f'.repeat(40),
  };
  assert.notEqual(
    (
      await call({
        action: 'initial-code-snapshot',
        taskId,
        questionId,
        snapshot: wrong,
      })
    ).status,
    200,
  );
  assert.notEqual(
    (
      await call({
        action: 'finish',
        taskId,
        turnId: questionId,
        jobToken: retry.turn.jobToken,
        success: true,
        container: old,
      })
    ).status,
    200,
  );
  await run({
    action: 'finish',
    taskId,
    turnId: questionId,
    jobToken: retry.turn.jobToken,
    success: false,
    stage: 'snapshot',
    error: 'synthetic stop',
    container: current,
  });
  const final = await latest();
  assert.equal(final.turns[0].container.questionId, questionId);
  assert.equal(final.initialCodeSnapshots[questionId].sha, snapshot.sha);
  console.log(
    'Initial snapshot API: prior context failure, correct question selection, immutable commit and foreign success rejection passed',
  );
  await api(
    '/api/tasks/' + taskId,
    { action: 'close', revision: final.revision },
    'PATCH',
  );
}
