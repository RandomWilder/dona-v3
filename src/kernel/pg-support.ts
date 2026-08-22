import { Pool } from 'pg';
import { KernelError } from './errors.ts';
import { migrate } from './migrate.ts';

// Named to avoid node --test's `test-*` collection pattern: this is a helper,
// not a suite.
const defaultUrl = 'postgres://dona:dona@127.0.0.1:5434/dona';

export async function migratedPoolOrNull(): Promise<Pool | null> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? defaultUrl,
    connectionTimeoutMillis: 1500,
    allowExitOnIdle: true,
  });
  try {
    await pool.query('SELECT 1');
  } catch (cause) {
    await pool.end();
    // Locally an absent database means "skip the durability suite". In CI that
    // would be a gate that lies: every durability test would pass by not
    // running. REQUIRE_POSTGRES=1 turns the skip back into a failure.
    if (process.env.REQUIRE_POSTGRES === '1') {
      throw new KernelError(
        'unavailable',
        'REQUIRE_POSTGRES=1 but the database is unreachable',
        { reason: cause instanceof Error ? cause.message : 'unknown' },
      );
    }
    return null;
  }
  await migrate(pool);
  return pool;
}

export const skipReason = 'postgres not running — npm run db:up';
