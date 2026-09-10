import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  containerImage,
  legacyContainerImage,
  containerBaseDigest,
  containerClaudeVersion,
  containerNodeVersion,
  containerImagePolicy,
  resolveContainerImage,
  validDockerSnapshot,
  dockerSnapshot,
} from '../lib/container-policy.mjs';

const id = 'sha256:' + 'a'.repeat(64);
const image = () => ({
  Id: id,
  RepoDigests: [],
  Config: {
    User: 'node',
    WorkingDir: '/workspace',
    Entrypoint: ['/usr/local/bin/entrypoint.sh'],
    Cmd: ['interactive'],
    Labels: {
      'annotation.pipeline.base-image': legacyContainerImage,
      'annotation.pipeline.base-digest': containerBaseDigest,
      'annotation.pipeline.claude-version': containerClaudeVersion,
      'annotation.pipeline.node-version': containerNodeVersion,
      'annotation.pipeline.image-policy': containerImagePolicy,
    },
  },
});

test('locally built runtime selects its immutable Docker ID without inventing a registry digest', () => {
  assert.deepEqual(resolveContainerImage(image()), {
    digest: id,
    imageId: id,
    claudeVersion: containerClaudeVersion,
    nodeVersion: containerNodeVersion,
    baseDigest: containerBaseDigest,
  });
  assert.equal(dockerSnapshot(id), 'docker://' + containerImage + '@' + id);
});

test('new runtime rejects old CLI, wrong base, missing provenance and altered entrypoints', () => {
  for (const key of Object.keys(image().Config.Labels)) {
    const changed = image();
    changed.Config.Labels[key] = 'wrong';
    assert.throws(() => resolveContainerImage(changed), /不符合/);
  }
  for (const [key, value] of [
    ['User', 'root'],
    ['WorkingDir', '/root'],
    ['Entrypoint', ['sh']],
    ['Cmd', ['print']],
  ]) {
    const changed = image();
    changed.Config[key] = value;
    assert.throws(() => resolveContainerImage(changed), /不符合/);
  }
  assert.throws(
    () => resolveContainerImage({ ...image(), Id: 'latest' }),
    /不符合/,
  );
  assert.throws(() => resolveContainerImage({ Id: id, Config: {} }), /不符合/);
});

test('legacy task snapshots remain valid and unknown tags or repeated digests are rejected', () => {
  assert.equal(
    validDockerSnapshot('docker://' + legacyContainerImage + '@' + id),
    true,
  );
  assert.equal(validDockerSnapshot(dockerSnapshot(id)), true);
  assert.equal(validDockerSnapshot(dockerSnapshot(id) + '@' + id), false);
  assert.equal(
    validDockerSnapshot(
      'docker://annotation-pipeline/claude-code:latest@' + id,
    ),
    false,
  );
});

test('scheduler fixture supplies the same required image metadata as the real runtime', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-image-fixture-'));
  try {
    const cli = path.join(dir, 'docker');
    symlinkSync(
      fileURLToPath(new URL('./fixtures/pipeline-cli.cjs', import.meta.url)),
      cli,
    );
    const [fake] = JSON.parse(
      execFileSync(
        process.execPath,
        [cli, 'image', 'inspect', containerImage],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(
      resolveContainerImage(fake).claudeVersion,
      containerClaudeVersion,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
