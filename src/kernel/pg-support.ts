import { Pool } from 'pg';
import { migrate } from './migrate.ts';

// Named to avoid node --test's `test-*` collection pattern: this is a helper,
// not a suite.
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgres://dona:dona@127.0.0.1:5434/dona';

export async function migratedPoolOrNull(): Promise<Pool | null> {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1500,
    allowExitOnIdle: true,
  });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end();
    return null;
  }
  await migrate(pool);
  return pool;
}

export const skipReason = 'postgres not running — npm run db:up';
