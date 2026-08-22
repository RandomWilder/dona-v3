import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuditLog } from './audit.ts';
import { fixedClock } from './clock.ts';
import { KernelError } from './errors.ts';
import { newId } from './ids.ts';
import { migratedPoolOrNull, skipReason } from './pg-support.ts';

interface Row {
  actor_kind: string;
  actor_id: string | null;
  action: string;
  subject_id: string | null;
  inputs: Record<string, unknown>;
  outcome: string;
  error_code: string | null;
  at: Date;
}

async function rowFor(
  pool: Awaited<ReturnType<typeof migratedPoolOrNull>>,
  subjectId: string,
): Promise<Row | undefined> {
  const result = await pool?.query<Row>(
    `SELECT actor_kind, actor_id, action, subject_id, inputs, outcome,
            error_code, at
     FROM audit_log WHERE subject_id = $1`,
    [subjectId],
  );
  return result?.rows[0];
}

describe('audit log', () => {
  it('records actor, action, inputs and outcome for a successful command', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const clock = fixedClock(new Date('2026-08-22T10:00:00Z'));
      const audit = createAuditLog(pool, clock);
      const subjectId = `case:${newId()}`;

      const value = await audit.around(
        {
          actorKind: 'tenant',
          actorId: 'tenant-7',
          action: 'case.open',
          subjectId,
          inputs: { category: 'plumbing' },
        },
        async () => 'opened',
      );

      assert.equal(value, 'opened');
      const row = await rowFor(pool, subjectId);
      assert.partialDeepStrictEqual(row, {
        actor_kind: 'tenant',
        actor_id: 'tenant-7',
        action: 'case.open',
        inputs: { category: 'plumbing' },
        outcome: 'ok',
        error_code: null,
      });
      assert.equal(row?.at.toISOString(), '2026-08-22T10:00:00.000Z');
    } finally {
      await pool.end();
    }
  });

  it('records the failure and still lets the error through', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const audit = createAuditLog(pool);
      const subjectId = `case:${newId()}`;

      await assert.rejects(
        audit.around(
          {
            actorKind: 'agent',
            action: 'case.close',
            subjectId,
            inputs: { reason: 'resolved' },
          },
          async () => {
            throw new KernelError('not_allowed', 'tenant may not close');
          },
        ),
        (error: unknown) =>
          error instanceof KernelError && error.code === 'not_allowed',
      );

      assert.partialDeepStrictEqual(await rowFor(pool, subjectId), {
        actor_kind: 'agent',
        actor_id: null,
        outcome: 'error',
        error_code: 'not_allowed',
      });
    } finally {
      await pool.end();
    }
  });

  it('files an unknown failure under unavailable, leaking nothing else', async (t) => {
    const pool = await migratedPoolOrNull();
    if (!pool) {
      t.skip(skipReason);
      return;
    }
    try {
      const audit = createAuditLog(pool);
      const subjectId = `job:${newId()}`;

      await assert.rejects(
        audit.around(
          {
            actorKind: 'system',
            action: 'job.price',
            subjectId,
            inputs: {},
          },
          async () => {
            throw new Error('connect ECONNREFUSED');
          },
        ),
      );

      assert.partialDeepStrictEqual(await rowFor(pool, subjectId), {
        outcome: 'error',
        error_code: 'unavailable',
      });
    } finally {
      await pool.end();
    }
  });
});
