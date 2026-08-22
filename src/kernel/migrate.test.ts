import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { migrate } from './migrate.ts';

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
      assert.deepEqual(
        applied.rows.map((row) => row.filename),
        ['0001_init.sql'],
      );
      const vector = await pool.query(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      assert.equal(vector.rowCount, 1);
    } finally {
      await pool.end();
    }
  });
});
