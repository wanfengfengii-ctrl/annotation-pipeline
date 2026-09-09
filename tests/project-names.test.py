"""Exercise the real migration, including concurrent creation and durable IDs."""
import concurrent.futures
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class ProjectNamesTest(unittest.TestCase):
    def test_migration_and_concurrent_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(pathlib.Path(directory) / 'tasks.db')
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY, created_at TEXT, data TEXT)')
                c.executemany('INSERT INTO tasks VALUES(?,?,?)', [('later','2026-09-10','{}'),('first','2026-09-09','{}')])
                c.executescript((ROOT / 'drizzle/0003_certain_rogue.sql').read_text())
                self.assertEqual(c.execute("SELECT task_id, printf('nyh-%05d',sequence) FROM project_names ORDER BY sequence").fetchall(), [('first','nyh-00001'),('later','nyh-00002')])
            def create(i):
                with sqlite3.connect(db, timeout=10) as c:
                    c.execute('INSERT INTO tasks VALUES(?,?,?)', (f'new-{i}','2026-09-11','{}'))
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(create,range(12)))
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute('SELECT sequence FROM project_names ORDER BY sequence').fetchall(), [(i,) for i in range(1,15)])
                c.execute("UPDATE tasks SET data='{}' WHERE id='first'")
                c.execute("DELETE FROM tasks WHERE id='later'")
                c.execute("INSERT INTO tasks VALUES('last','2026-09-12','{}')")
                self.assertEqual(c.execute("SELECT sequence FROM project_names WHERE task_id='last'").fetchone(), (15,))
                self.assertEqual(c.execute("SELECT sequence FROM project_names WHERE task_id='first'").fetchone(), (1,))

if __name__ == '__main__':
    unittest.main()
