import type { Pool, PoolClient } from 'pg';
import {
  type ActorKind,
  type AuditLog,
  createAuditLog,
} from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import {
  createIdempotency,
  type IdempotencyStore,
} from '../../kernel/idempotency.ts';
import { newId } from '../../kernel/ids.ts';
import { normalizePhone } from './phone.ts';

export const personKinds = ['tenant', 'vendor', 'staff'] as const;
export type PersonKind = (typeof personKinds)[number];

export const languages = ['he', 'en'] as const;
export type Language = (typeof languages)[number];

const maxNameLength = 200;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Who is asking. Every mutation records one, so the audit trail can answer
// "which agent created this person" without a second system.
export interface Actor {
  kind: ActorKind;
  id?: string;
}

export interface Person {
  id: string;
  displayName: string;
  language: Language;
  kinds: PersonKind[];
}

export interface AddPersonInput {
  intentKey: string;
  displayName: string;
  kinds: PersonKind[];
  language?: Language;
}

export interface AddPhoneInput {
  personId: string;
  phone: string;
}

export interface PhoneLink {
  personId: string;
  phone: string;
}

export interface Identity {
  addPerson(input: AddPersonInput, actor: Actor): Promise<Person>;
  addPhone(input: AddPhoneInput, actor: Actor): Promise<PhoneLink>;
  findByPhone(phone: string): Promise<Person | null>;
}

export interface IdentityDeps {
  pool: Pool;
  clock?: Clock;
  audit?: AuditLog;
  idempotency?: IdempotencyStore;
}

interface PersonRow {
  id: string;
  display_name: string;
  language: Language;
  kinds: PersonKind[];
}

export function createIdentity(deps: IdentityDeps): Identity {
  const { pool } = deps;
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(pool, clock);
  const idempotency = deps.idempotency ?? createIdempotency(pool, { clock });

  async function insertPerson(person: Person, at: Date): Promise<void> {
    // A person with no kinds is a broken row, so the person and its kinds land
    // together or not at all.
    await inTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO identity_people (id, display_name, language, created_at)
         VALUES ($1, $2, $3, $4)`,
        [person.id, person.displayName, person.language, at],
      );
      for (const kind of person.kinds) {
        await client.query(
          'INSERT INTO identity_person_kinds (person_id, kind) VALUES ($1, $2)',
          [person.id, kind],
        );
      }
    });
  }

  return {
    async addPerson(input, actor) {
      // Validation runs inside the audited work, so a rejected command leaves
      // an `error` row rather than disappearing.
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'identity.addPerson',
          subjectId: asText(input?.intentKey),
          inputs: {
            intentKey: asText(input?.intentKey),
            displayName: asText(input?.displayName),
            kinds: input?.kinds,
            language: input?.language,
          },
        },
        async () => {
          const intentKey = requireText(input?.intentKey, 'intentKey', 200);
          const displayName = requireText(
            input?.displayName,
            'displayName',
            maxNameLength,
          );
          const kinds = validKinds(input?.kinds);
          const language = validLanguage(input?.language);

          return idempotency.once(
            `identity.addPerson:${intentKey}`,
            async () => {
              const person: Person = {
                id: newId(clock),
                displayName,
                language,
                kinds,
              };
              await insertPerson(person, clock.now());
              return person;
            },
          );
        },
      );
    },

    async addPhone(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'identity.addPhone',
          subjectId: asText(input?.personId),
          inputs: {
            personId: asText(input?.personId),
            phone: asText(input?.phone),
          },
        },
        async () => {
          const personId = validId(input?.personId);
          const phone = normalizePhone(input?.phone);

          const person = await pool.query(
            'SELECT 1 FROM identity_people WHERE id = $1',
            [personId],
          );
          if (person.rowCount === 0) {
            throw new KernelError('not_found', 'person not found');
          }

          // The unique index is the idempotency: this command's intent is its
          // data, so no kernel key is needed to say the same thing twice.
          const inserted = await pool.query(
            `INSERT INTO identity_phones (phone, person_id, created_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (phone) DO NOTHING
             RETURNING person_id`,
            [phone, personId, clock.now()],
          );
          if (inserted.rowCount === 0) {
            const owner = await pool.query<{ person_id: string }>(
              'SELECT person_id FROM identity_phones WHERE phone = $1',
              [phone],
            );
            // Same person repeating themselves is fine. A different person is
            // two tenancies claiming one number, which must never be guessed.
            if (owner.rows[0]?.person_id !== personId) {
              throw new KernelError(
                'conflict',
                'phone already belongs to another person',
              );
            }
          }
          return { personId, phone };
        },
      );
    },

    async findByPhone(phone) {
      const normalized = normalizePhone(phone);
      const found = await pool.query<PersonRow>(
        `SELECT p.id, p.display_name, p.language,
                coalesce(
                  array_agg(k.kind ORDER BY k.kind) FILTER (WHERE k.kind IS NOT NULL),
                  '{}'
                ) AS kinds
           FROM identity_phones ph
           JOIN identity_people p ON p.id = ph.person_id
           LEFT JOIN identity_person_kinds k ON k.person_id = p.id
          WHERE ph.phone = $1
          GROUP BY p.id, p.display_name, p.language`,
        [normalized],
      );
      const row = found.rows[0];
      // A number nobody holds is an answer, not a failure. See SPEC-identity.md.
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        displayName: row.display_name,
        language: row.language,
        kinds: row.kinds,
      };
    },
  };
}

async function inTransaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Edge validation. Everything a caller can get wrong becomes `invalid` here,
// rather than a Postgres cast error surfacing as `unavailable` later.
function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new KernelError('invalid', `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new KernelError('invalid', `${field} must be 1 to ${max} characters`);
  }
  return trimmed;
}

function validId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new KernelError('invalid', 'personId is not an id');
  }
  return value;
}

function validKinds(value: unknown): PersonKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new KernelError('invalid', 'at least one kind is required');
  }
  const unique = [...new Set(value)];
  for (const kind of unique) {
    if (!personKinds.includes(kind as PersonKind)) {
      throw new KernelError('invalid', 'unknown person kind', { kind });
    }
  }
  return (unique as PersonKind[]).sort();
}

function validLanguage(value: unknown): Language {
  if (value === undefined) {
    return 'he';
  }
  if (!languages.includes(value as Language)) {
    throw new KernelError('invalid', 'unknown language', { language: value });
  }
  return value as Language;
}

// Audit inputs must survive a caller passing nonsense, since the audit entry is
// built before validation runs.
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
