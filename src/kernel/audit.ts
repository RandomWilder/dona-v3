import type { Pool } from 'pg';
import { type Clock, systemClock } from './clock.ts';
import { KernelError } from './errors.ts';
import { newId } from './ids.ts';

export type ActorKind = 'tenant' | 'staff' | 'agent' | 'system';

export interface AuditEntry {
  actorKind: ActorKind;
  actorId?: string;
  action: string;
  subjectId?: string;
  inputs: Record<string, unknown>;
}

export interface AuditLog {
  write(entry: AuditEntry, outcome: AuditOutcome): Promise<void>;
  around<T>(entry: AuditEntry, work: () => Promise<T>): Promise<T>;
}

export type AuditOutcome =
  | { outcome: 'ok' }
  | { outcome: 'error'; code?: string; message?: string };

export function createAuditLog(
  pool: Pool,
  clock: Clock = systemClock,
): AuditLog {
  async function write(entry: AuditEntry, result: AuditOutcome): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log
         (id, at, actor_kind, actor_id, action, subject_id, inputs,
          outcome, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        newId(clock),
        clock.now(),
        entry.actorKind,
        entry.actorId ?? null,
        entry.action,
        entry.subjectId ?? null,
        JSON.stringify(entry.inputs),
        result.outcome,
        result.outcome === 'error' ? (result.code ?? null) : null,
        result.outcome === 'error' ? (result.message ?? null) : null,
      ],
    );
  }

  return {
    write,
    async around<T>(entry: AuditEntry, work: () => Promise<T>): Promise<T> {
      try {
        const value = await work();
        await write(entry, { outcome: 'ok' });
        return value;
      } catch (error) {
        await write(entry, {
          outcome: 'error',
          code: error instanceof KernelError ? error.code : 'unavailable',
          message: error instanceof Error ? error.message : undefined,
        });
        throw error;
      }
    },
  };
}
