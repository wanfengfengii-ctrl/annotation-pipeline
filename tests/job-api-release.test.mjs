import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertApiReleaseCompatible } from '../scripts/publish-job-release.mjs';

test('a live API must accept the new job audit version before pointer activation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'job-api-release-'));
  try {
    const work = path.join(root, 'work');
    mkdirSync(work);
    mkdirSync(path.join(root, 'rules'));
    writeFileSync(path.join(root, 'rules/question-writing.json'), JSON.stringify({version:'new'}));
    const check = (alive = () => true) => assertApiReleaseCompatible(root, work, alive);
    assert.doesNotThrow(() => check()); // First installation, no API owner.
    const state = (version) => writeFileSync(path.join(work, 'local-api.json'),
      JSON.stringify({supervisorPid:123, phase:'healthy', questionRuleVersion:version}));
    state('old');
    assert.throws(() => check(), /先构建并升级 API/);
    state(undefined);
    assert.throws(() => check(), /未记录/);
    state('new');
    assert.doesNotThrow(() => check());
    state('old');
    assert.doesNotThrow(() => check(() => false)); // Historical stopped monitor.
  } finally {
    rmSync(root, {recursive:true, force:true});
  }
});
