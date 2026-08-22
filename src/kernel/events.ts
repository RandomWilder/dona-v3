import type { Pool } from 'pg';
import { type Clock, systemClock } from './clock.ts';
import { newId } from './ids.ts';

export interface DomainEvent {
  id: string;
  type: string;
  subjectId: string;
  payload: Record<string, unknown>;
  at: Date;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

export interface EventBus {
  publish(input: Omit<DomainEvent, 'id' | 'at'>): Promise<void>;
  subscribe(type: string, handler: EventHandler): void;
  deliverPending(): Promise<void>;
}

interface OutboxRow {
  id: string;
  type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  at: Date;
}

export function createEventBus(
  pool: Pool,
  clock: Clock = systemClock,
): EventBus {
  const handlers = new Map<string, EventHandler[]>();

  async function deliver(event: DomainEvent): Promise<void> {
    let lastError: string | undefined;
    for (const handler of handlers.get(event.type) ?? []) {
      try {
        await handler(event);
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'handler failed';
      }
    }
    if (lastError) {
      await pool.query('UPDATE outbox SET last_error = $2 WHERE id = $1', [
        event.id,
        lastError,
      ]);
      return;
    }
    await pool.query(
      'UPDATE outbox SET handled_at = $2, last_error = NULL WHERE id = $1',
      [event.id, clock.now()],
    );
  }

  return {
    // The row is written before delivery is attempted, so an event is never
    // lost to a handler that throws or a process that dies mid-delivery.
    async publish(input) {
      const event: DomainEvent = {
        ...input,
        id: newId(clock),
        at: clock.now(),
      };
      await pool.query(
        `INSERT INTO outbox (id, type, subject_id, payload, at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          event.id,
          event.type,
          event.subjectId,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
      await deliver(event);
    },

    subscribe(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },

    async deliverPending() {
      const pending = await pool.query<OutboxRow>(
        `SELECT id, type, subject_id, payload, at
         FROM outbox WHERE handled_at IS NULL ORDER BY at`,
      );
      for (const row of pending.rows) {
        await deliver({
          id: row.id,
          type: row.type,
          subjectId: row.subject_id,
          payload: row.payload,
          at: new Date(row.at),
        });
      }
    },
  };
}
