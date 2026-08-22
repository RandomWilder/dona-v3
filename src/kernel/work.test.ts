import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixedClock } from './clock.ts';
import { newId } from './ids.ts';
import { migratedPoolOrNull, skipReason } from './pg-support.ts';
import { createWorkRunner } from './work.ts';

const start = new Date('2026-08-22T10:00:00Z');

describe('durable work', () => {
  it('runs work once it is due, and not before', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(start);
      const runner = createWorkRunner(pool, { clock });
      const kind = `offer.timeout:${newId()}`;
      const seen: unknown[] = [];
      runner.register(kind, async (payload) => {
        seen.push(payload);
      });

      await runner.schedule({
        kind,
        runAt: new Date(start.getTime() + 30 * 60_000),
        payload: { offerId: 'o-1' },
      });

      await runner.tick();
      assert.deepEqual(seen, []);

      clock.advance(30 * 60_000);
      await runner.tick();
      assert.deepEqual(seen, [{ offerId: 'o-1' }]);

      // Completed work is not picked up again.
      await runner.tick();
      assert.equal(seen.length, 1);
    } finally {
      await pool.end();
    }
  });

  it('does not run cancelled work', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(start);
      const runner = createWorkRunner(pool, { clock });
      const kind = `offer.timeout:${newId()}`;
      let runs = 0;
      runner.register(kind, async () => {
        runs += 1;
      });

      const id = await runner.schedule({
        kind,
        runAt: start,
        payload: {},
      });
      await runner.cancel(id);
      await runner.tick();

      assert.equal(runs, 0);
    } finally {
      await pool.end();
    }
  });

  it('schedules once per intent key', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const runner = createWorkRunner(pool, { clock: fixedClock(start) });
      const kind = `offer.timeout:${newId()}`;
      const intentKey = `offer:${newId()}`;

      const first = await runner.schedule({
        kind,
        runAt: start,
        payload: { n: 1 },
        intentKey,
      });
      const second = await runner.schedule({
        kind,
        runAt: start,
        payload: { n: 2 },
        intentKey,
      });

      assert.equal(first, second);
    } finally {
      await pool.end();
    }
  });

  it('runs work scheduled before a restart', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(start);
      const kind = `offer.timeout:${newId()}`;

      // The runner that scheduled the work never runs it — it is discarded,
      // standing in for a process that exited.
      const before = createWorkRunner(pool, { clock });
      await before.schedule({
        kind,
        runAt: start,
        payload: { offerId: 'survives' },
      });

      const after = createWorkRunner(pool, { clock });
      const seen: unknown[] = [];
      after.register(kind, async (payload) => {
        seen.push(payload);
      });
      await after.tick();

      assert.deepEqual(seen, [{ offerId: 'survives' }]);
    } finally {
      await pool.end();
    }
  });

  it('lets only one of two runners claim the same job', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(start);
      const kind = `offer.timeout:${newId()}`;
      let runs = 0;
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const handler = async () => {
        runs += 1;
        await held;
      };

      const left = createWorkRunner(pool, { clock });
      const right = createWorkRunner(pool, { clock });
      left.register(kind, handler);
      right.register(kind, handler);
      await left.schedule({ kind, runAt: start, payload: {} });

      const both = Promise.all([left.tick(), right.tick()]);
      release();
      await both;

      assert.equal(runs, 1);
    } finally {
      await pool.end();
    }
  });

  it('backs off and retries when a handler fails', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(start);
      const runner = createWorkRunner(pool, { clock });
      const kind = `offer.timeout:${newId()}`;
      let attempts = 0;
      runner.register(kind, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('vendor api down');
        }
      });

      const id = await runner.schedule({ kind, runAt: start, payload: {} });
      await runner.tick();
      assert.equal(attempts, 1);

      const failed = await pool.query<{
        last_error: string;
        done_at: Date | null;
      }>('SELECT last_error, done_at FROM scheduled_work WHERE id = $1', [id]);
      assert.equal(failed.rows[0]?.last_error, 'vendor api down');
      assert.equal(failed.rows[0]?.done_at, null);

      // Still backing off, then due again.
      await runner.tick();
      assert.equal(attempts, 1);

      clock.advance(1000);
      await runner.tick();
      assert.equal(attempts, 2);

      const done = await pool.query<{
        last_error: string | null;
        done_at: Date | null;
      }>('SELECT last_error, done_at FROM scheduled_work WHERE id = $1', [id]);
      assert.notEqual(done.rows[0]?.done_at, null);
      assert.equal(done.rows[0]?.last_error, null);
    } finally {
      await pool.end();
    }
  });
});
