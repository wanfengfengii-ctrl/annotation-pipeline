import test from 'node:test';
import assert from 'node:assert/strict';
import {
  soloStatusSnapshot,
  validateSoloStatusSnapshot,
} from '../lib/solo-upload-status.mjs';
const at = '2026-09-10T00:00:00.000Z';
test('remote outcomes, holds and pending work stay distinct, without private ledger fields', () => {
  const ledger = {
    entries: {
      't:a': {
        state: 'submitted',
        remoteId: 1,
        remoteStatus: 'PENDING_FIX',
        receiptVerified: true,
        remoteReason: '原题ID不一致',
        privateToken: 'secret',
        updatedAt: at,
      },
      't:b': { state: 'prepared' },
      't:c': { state: 'uncertain' },
      't:d': {
        state: 'submitted',
        remoteId: 2,
        remoteStatus: 'QC_PASSED',
        receiptVerified: true,
      },
      't:e': { state: 'prepared' },
    },
    lastPlan: { blocked: [{ key: 't:e', reason: '前序缺失' }] },
  };
  const s = soloStatusSnapshot(
    ledger,
    { entries: { 't:b': { reason: '话语重复', markedAt: at } } },
    at,
  );
  assert.deepEqual(
    Object.values(s.entries).map((x) => x.status),
    ['needs_fix', 'held', 'uncertain', 'passed', 'blocked'],
  );
  assert.equal(s.entries['t:a'].remoteId, 1);
  assert.ok(!JSON.stringify(s).includes('secret'));
  assert.equal(ledger.entries['t:b'].state, 'prepared');
});
test('an unverified remote number cannot claim an outcome or quality pass', () => {
  for (const remoteStatus of ['SUBMITTED', 'QC_PASSED', 'PENDING_FIX']) {
    const s = soloStatusSnapshot(
      { entries: { 't:a': { state: 'submitted', remoteId: 1, remoteStatus } } },
      { entries: {} },
      at,
    );
    assert.equal(s.entries['t:a'].status, 'uncertain');
  }
});
test('status validation rejects unknown states and invalid links, strips unsolicited fields', () => {
  const s = soloStatusSnapshot(
    { entries: { 't:a': { state: 'prepared' } } },
    { entries: {} },
    at,
  );
  for (const change of [
    { status: 'invented' },
    { remoteId: -1 },
    { remoteId: 'https://evil.invalid' },
    { updatedAt: 'bad' },
  ])
    assert.throws(() =>
      validateSoloStatusSnapshot({
        ...s,
        entries: { 't:a': { ...s.entries['t:a'], ...change } },
      }),
    );
  assert.equal(
    validateSoloStatusSnapshot({ ...s, secret: 'no' }).secret,
    undefined,
  );
});
