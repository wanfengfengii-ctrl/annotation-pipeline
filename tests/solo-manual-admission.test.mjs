import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyManualAdmissions } from '../scripts/solo-manual-admission.mjs';
import { digest } from '../scripts/solo-records.mjs';
test('有限历史授权绑定字段和原证据，禁止上传优先，其他记录不放行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-admission-'));
  try {
    const proof = path.join(root, 'proof');
    fs.writeFileSync(proof, 'original');
    const row = {
      taskId: 't',
      turnId: 'a',
      eligible: false,
      values: ['source'],
      nativeIdentity: { sessionId: 's', promptId: 'p' },
    };
    const entry = {
      sourceValuesDigest: digest(row.values),
      authorizedByUser: true,
      wordingPassed: true,
      evidence: [{ path: proof, sha256: digest('original') }],
      values: ['reviewed'],
      approvedValuesDigest: digest(['reviewed']),
      sessionId: 's',
      promptId: 'p',
    };
    fs.writeFileSync(
      path.join(root, 'manual-admissions.json'),
      JSON.stringify({
        version: 1,
        userInstruction: 'User approved this one record',
        entries: { 't:a': entry },
      }),
    );
    assert.equal(applyManualAdmissions([row], root)[0].eligible, true);
    assert.equal(
      applyManualAdmissions([{ ...row, turnId: 'b' }], root)[0].eligible,
      false,
    );
    assert.equal(
      applyManualAdmissions(
        [{ ...row, uploadHold: { reason: 'duplicate' } }],
        root,
      )[0].eligible,
      false,
    );
    assert.equal(
      applyManualAdmissions([{ ...row, values: ['changed'] }], root)[0]
        .eligible,
      false,
    );
    fs.writeFileSync(proof, 'changed');
    assert.equal(applyManualAdmissions([row], root)[0].eligible, false);
    assert.deepEqual(row.values, ['source']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
