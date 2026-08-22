import type { Pool } from 'pg';
import { type Clock, systemClock } from './clock.ts';
import { KernelError } from './errors.ts';
import { newId } from './ids.ts';

export type WorkHandler = (payload: Record<string, unknown>) => Promise<void>;

export interface ScheduleInput {
  kind: string;
  runAt: Date;
  payload: Record<string, unknown>;
  intentKey?: string;
}

export interface WorkRunner {
  schedule(input: ScheduleInput): Promise<string>;
  cancel(id: string): Promise<void>;
  register(kind: string, handler: WorkHandler): void;
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface WorkOptions {
  clock?: Clock;
  tickMs?: number;
  lockMs?: number;
}

interface ClaimedRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

export function createWorkRunner(
  pool: Pool,
  options: WorkOptions = {},
): WorkRunner {
  const clock = options.clock ?? systemClock;
  const tickMs = options.tickMs ?? 1000;
  const lockMs = options.lockMs ?? 30_000;
  const handlers = new Map<string, WorkHandler>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inflight: Promise<void> = Promise.resolve();

  // SKIP LOCKED is what makes two runners safe: neither can take the same row.
  async function claim(): Promise<ClaimedRow | undefined> {
    const now = clock.now();
    const result = await pool.query<ClaimedRow>(
      `UPDATE scheduled_work SET
         attempts = attempts + 1,
         locked_until = $2
       WHERE id = (
         SELECT id FROM scheduled_work
         WHERE done_at IS NULL
           AND run_at <= $1
           AND (locked_until IS NULL OR locked_until <= $1)
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, kind, payload, attempts`,
      [now, new Date(now.getTime() + lockMs)],
    );
    return result.rows[0];
  }

  async function release(job: ClaimedRow, lastError: string): Promise<void> {
    await pool.query(
      `UPDATE scheduled_work
       SET locked_until = NULL, run_at = $2, last_error = $3
       WHERE id = $1`,
      [
        job.id,
        new Date(clock.now().getTime() + backoffMs(job.attempts)),
        lastError,
      ],
    );
  }

  async function runOne(job: ClaimedRow): Promise<void> {
    const handler = handlers.get(job.kind);
    if (!handler) {
      await release(job, 'no handler');
      return;
    }
    try {
      await handler(job.payload);
      await pool.query(
        'UPDATE scheduled_work SET done_at = $2, last_error = NULL WHERE id = $1',
        [job.id, clock.now()],
      );
    } catch (error) {
      await release(
        job,
        error instanceof Error ? error.message : 'work failed',
      );
    }
  }

  async function tick(): Promise<void> {
    for (;;) {
      const job = await claim();
      if (!job) {
        return;
      }
      await runOne(job);
    }
  }

  return {
    async schedule(input) {
      const id = newId(clock);
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO scheduled_work (id, kind, payload, run_at, intent_key)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (intent_key) DO NOTHING
         RETURNING id`,
        [
          id,
          input.kind,
          JSON.stringify(input.payload),
          input.runAt,
          input.intentKey ?? null,
        ],
      );
      if (inserted.rows[0]) {
        return inserted.rows[0].id;
      }
      const existing = await pool.query<{ id: string }>(
        'SELECT id FROM scheduled_work WHERE intent_key = $1',
        [input.intentKey ?? null],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new KernelError('unavailable', 'could not schedule work', {
          kind: input.kind,
        });
      }
      return row.id;
    },

    async cancel(id) {
      await pool.query(
        'UPDATE scheduled_work SET done_at = $2 WHERE id = $1 AND done_at IS NULL',
        [id, clock.now()],
      );
    },

    register(kind, handler) {
      handlers.set(kind, handler);
    },

    tick,

    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => {
        inflight = inflight.then(tick, tick);
      }, tickMs);
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await inflight;
    },
  };
}
