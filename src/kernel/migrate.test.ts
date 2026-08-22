import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { migrate } from './migrate.ts';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://dona:dona@127.0.0.1:5434/dona';

async function connectOrNull(): Promise<Pool | null> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1500,
    allowExitOnIdle: true,
  });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch {
    await pool.end();
    return null;
  }
}

describe('numbered migrations', () => {
  it('applies in order, records files, and is safe to run twice', async (t) => {
    const pool = await connectOrNull();
    if (!pool) {
      t.skip('postgres not running — npm run db:up');
      return;
    }
    try {
      await migrate(pool);
      await migrate(pool);
      const applied = await pool.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations ORDER BY filename',
      );
      // Every numbered file on disk, applied exactly once, in order — asserted
      // against the directory so adding a migration never edits this test.
      const onDisk = (await readdir(migrationsDir))
        .filter((name) => /^\d+_.*\.sql$/.test(name))
        .sort();
      assert.deepEqual(
        applied.rows.map((row) => row.filename),
        onDisk,
      );
      assert.ok(onDisk.length >= 2);
      const vector = await pool.query(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      assert.equal(vector.rowCount, 1);
    } finally {
      await pool.end();
    }
  });
});
