import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

export async function migrate(pool: Pool): Promise<void> {
  await pool.query('SELECT pg_advisory_lock(872403)');
  try {
    await applyMigrations(pool);
  } finally {
    await pool.query('SELECT pg_advisory_unlock(872403)');
  }
}

async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  const applied = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations',
  );
  const done = new Set(applied.rows.map((row) => row.filename));
  for (const filename of files) {
    if (done.has(filename)) {
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
