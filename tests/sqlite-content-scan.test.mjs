import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSqliteContent } from '../scripts/sqlite-content-scan.mjs';

function sqlite(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sqlite-content-test-'));
  try {
    const file = path.join(dir, 'test.db');
    execFileSync(
      'python3',
      [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.stdin.read()); c.commit(); c.close()',
        file,
      ],
      { input: sql },
    );
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ordinary SQLite is checked without changing its bytes', () => {
  const bytes = sqlite(
    "CREATE TABLE tasks(id INTEGER, status TEXT); INSERT INTO tasks VALUES(1,'done');",
  );
  const before = Buffer.from(bytes),
    scan = scanSqliteContent(bytes);
  assert.equal(scan.status, 'passed');
  assert.equal(scan.rows, 1);
  assert.deepEqual(bytes, before);
});

test('column credentials, key/value secrets, nested values and deleted raw secrets remain held', () => {
  const cases = [
    "CREATE TABLE users(password TEXT); INSERT INTO users VALUES('long-private-value');",
    "CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES('password','long-private-value');",
    `CREATE TABLE logs(payload TEXT); INSERT INTO logs VALUES('{"password":"long-private-value"}');`,
    "CREATE TABLE users(email TEXT); INSERT INTO users VALUES('person@real-mail.local');",
    "PRAGMA secure_delete=OFF; CREATE TABLE old(value TEXT); INSERT INTO old VALUES('fixture-private-key-8324'); DELETE FROM old;",
  ];
  for (const sql of cases) {
    const bytes = sqlite(sql),
      before = Buffer.from(bytes);
    assert.equal(
      scanSqliteContent(bytes, { knownSecrets: ['fixture-private-key-8324'] })
        .status,
      'needs_review',
    );
    assert.deepEqual(bytes, before);
  }
});

test('unsupported encoding, generated columns, virtual tables, binary blobs and corrupt files fail closed', () => {
  const inputs = [
    sqlite("PRAGMA encoding='UTF-16'; CREATE TABLE items(value TEXT);"),
    sqlite(
      'CREATE TABLE items(a INTEGER, b INTEGER GENERATED ALWAYS AS (a+1));',
    ),
    sqlite('CREATE VIRTUAL TABLE documents USING fts5(content);'),
    sqlite(
      "CREATE TABLE items(value BLOB); INSERT INTO items VALUES(X'00FF');",
    ),
    Buffer.from('SQLite format 3\0broken'),
    Buffer.alloc(17 * 1024 * 1024),
  ];
  for (const bytes of inputs)
    assert.equal(scanSqliteContent(bytes).status, 'needs_review');
});
