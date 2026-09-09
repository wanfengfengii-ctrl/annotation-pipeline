import test from 'node:test';
import assert from 'node:assert/strict';
import { testServer } from './fixtures/test-server.mjs';
test('Integration fixtures reject production and remote targets before any write', () => {
  assert.equal(testServer('http://127.0.0.1:3001/'), 'http://127.0.0.1:3001');
  for (const value of [
    'http://localhost:3000',
    'https://example.com:3001',
    'http://example.com:3001',
    'http://localhost:3001/api',
    'http://localhost:3001/?target=production',
  ])
    assert.throws(() => testServer(value), /production URLs are blocked/);
});
