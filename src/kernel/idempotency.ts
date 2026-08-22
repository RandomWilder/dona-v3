import type { Pool } from 'pg';
import { type Clock, systemClock } from './clock.ts';
import { KernelError } from './errors.ts';

export interface IdempotencyStore {
  once<T>(key: string, work: () => Promise<T>): Promise<T>;
}

export interface IdempotencyOptions {
  clock?: Clock;
  staleAfterMs?: number;
}

interface KeyRow {
  state: 'running' | 'done';
  result: unknown;
}

export function createIdempotency(
  pool: Pool,
  options: IdempotencyOptions = {},
): IdempotencyStore {
  const clock = options.clock ?? systemClock;
  const staleAfterMs = options.staleAfterMs ?? 60_000;

  return {
    async once<T>(key: string, work: () => Promise<T>): Promise<T> {
      const now = clock.now();
      const stale = new Date(now.getTime() - staleAfterMs);
      // Claims a fresh key, or reclaims one abandoned by a dead process.
      const claim = await pool.query(
        `INSERT INTO idempotency_keys (key, state, claimed_at)
         VALUES ($1, 'running', $2)
         ON CONFLICT (key) DO UPDATE SET claimed_at = $2
         WHERE idempotency_keys.state = 'running'
           AND idempotency_keys.claimed_at <= $3
         RETURNING key`,
        [key, now, stale],
      );

      if (claim.rowCount === 0) {
        const existing = await pool.query<KeyRow>(
          'SELECT state, result FROM idempotency_keys WHERE key = $1',
          [key],
        );
        const row = existing.rows[0];
        if (row?.state === 'done') {
          return structuredClone(row.result) as T;
        }
        throw new KernelError('conflict', 'command already in progress', {
          key,
        });
      }

      try {
        const value = await work();
        await pool.query(
          `UPDATE idempotency_keys
           SET state = 'done', result = $2::jsonb, completed_at = $3
           WHERE key = $1`,
          [key, JSON.stringify(value ?? null), clock.now()],
        );
        return value;
      } catch (error) {
        // Failures stay retryable — only successful outcomes are memoized.
        await pool.query(
          `DELETE FROM idempotency_keys WHERE key = $1 AND state = 'running'`,
          [key],
        );
        throw error;
      }
    },
  };
}
