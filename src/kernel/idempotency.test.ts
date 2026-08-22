import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixedClock } from './clock.ts';
import { KernelError } from './errors.ts';
import { createIdempotency } from './idempotency.ts';
import { newId } from './ids.ts';
import { migratedPoolOrNull, skipReason } from './pg-support.ts';

describe('idempotency', () => {
  it('runs once per intent and replays the first result', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const store = createIdempotency(pool);
      const key = `job:${newId()}`;
      let runs = 0;
      const work = async () => {
        runs += 1;
        return { accepted: true, attempt: runs };
      };

      const first = await store.once(key, work);
      const second = await store.once(key, work);

      assert.equal(runs, 1);
      assert.deepEqual(first, { accepted: true, attempt: 1 });
      assert.deepEqual(second, first);
    } finally {
      await pool.end();
    }
  });

  it('hands back a copy, so callers cannot poison the stored result', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const store = createIdempotency(pool);
      const key = `job:${newId()}`;
      const first = await store.once(key, async () => ({ vendors: ['a'] }));
      first.vendors.push('tampered');

      const second = await store.once(key, async () => ({ vendors: ['b'] }));
      assert.deepEqual(second, { vendors: ['a'] });
    } finally {
      await pool.end();
    }
  });

  it('rejects a duplicate that arrives while the first is running', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const store = createIdempotency(pool);
      const key = `job:${newId()}`;
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const inflight = store.once(key, async () => {
        await held;
        return 'done';
      });
      await assert.rejects(
        store.once(key, async () => 'second'),
        (error: unknown) =>
          error instanceof KernelError && error.code === 'conflict',
      );

      release();
      assert.equal(await inflight, 'done');
    } finally {
      await pool.end();
    }
  });

  it('keeps a failed command retryable', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const store = createIdempotency(pool);
      const key = `job:${newId()}`;
      await assert.rejects(
        store.once(key, async () => {
          throw new KernelError('unavailable', 'database blip');
        }),
        (error: unknown) => error instanceof KernelError,
      );

      assert.equal(await store.once(key, async () => 'recovered'), 'recovered');
    } finally {
      await pool.end();
    }
  });

  it('reclaims a claim abandoned by a dead process', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-22T10:00:00Z'));
      const store = createIdempotency(pool, { clock, staleAfterMs: 60_000 });
      const key = `job:${newId()}`;

      // Simulates a process that claimed the key and died mid-command.
      await pool.query(
        `INSERT INTO idempotency_keys (key, state, claimed_at)
         VALUES ($1, 'running', $2)`,
        [key, clock.now()],
      );
      await assert.rejects(
        store.once(key, async () => 'blocked'),
        (error: unknown) =>
          error instanceof KernelError && error.code === 'conflict',
      );

      clock.advance(61_000);
      assert.equal(await store.once(key, async () => 'reclaimed'), 'reclaimed');
    } finally {
      await pool.end();
    }
  });
});
