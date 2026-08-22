import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEventBus, type DomainEvent } from './events.ts';
import { newId } from './ids.ts';
import { migratedPoolOrNull, skipReason } from './pg-support.ts';

interface OutboxState {
  handled_at: Date | null;
  last_error: string | null;
}

describe('outbox', () => {
  it('delivers a published event to its subscribers', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const bus = createEventBus(pool);
      const type = `case.opened:${newId()}`;
      const seen: DomainEvent[] = [];
      bus.subscribe(type, async (event) => {
        seen.push(event);
      });

      await bus.publish({
        type,
        subjectId: 'case-1',
        payload: { category: 'plumbing' },
      });

      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0]?.payload, { category: 'plumbing' });
    } finally {
      await pool.end();
    }
  });

  it('keeps the event when a handler throws, and replays it after a restart', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const type = `job.assigned:${newId()}`;
      const subjectId = `job:${newId()}`;

      const failing = createEventBus(pool);
      failing.subscribe(type, async () => {
        throw new Error('vendor service down');
      });
      await failing.publish({ type, subjectId, payload: { vendor: 'v1' } });

      const stored = await pool.query<OutboxState>(
        'SELECT handled_at, last_error FROM outbox WHERE subject_id = $1',
        [subjectId],
      );
      assert.equal(stored.rows[0]?.handled_at, null);
      assert.equal(stored.rows[0]?.last_error, 'vendor service down');

      // A fresh bus stands in for the process that comes back up.
      const recovered = createEventBus(pool);
      const seen: DomainEvent[] = [];
      recovered.subscribe(type, async (event) => {
        seen.push(event);
      });
      await recovered.deliverPending();

      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.subjectId, subjectId);
      const after = await pool.query<OutboxState>(
        'SELECT handled_at, last_error FROM outbox WHERE subject_id = $1',
        [subjectId],
      );
      assert.notEqual(after.rows[0]?.handled_at, null);
      assert.equal(after.rows[0]?.last_error, null);
    } finally {
      await pool.end();
    }
  });
});
