import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseSetupAction } from '../scripts/init-db.mjs';

void test('new databases and tracked migrations can initialize or resume', () => {
  assert.equal(databaseSetupAction(['_cf_KV']), 'migrate');
  assert.equal(
    databaseSetupAction(['d1_migrations', 'tasks', 'runners']),
    'migrate',
  );
});

void test('legacy manual schemas cannot be initialized over existing records', () => {
  for (const table of [
    'tasks',
    'runners',
    'review_history',
    'export_batches',
    'export_items',
    'project_names',
  ])
    assert.throws(
      () => databaseSetupAction(['_cf_KV', table]),
      /旧版手动初始化数据库/,
    );
});
