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
import { asText, requireText, validId } from '../../kernel/validate.ts';
import { normalizePhone } from './phone.ts';

export const personKinds = ['tenant', 'vendor', 'staff'] as const;
export type PersonKind = (typeof personKinds)[number];

export const languages = ['he', 'en'] as const;
export type Language = (typeof languages)[number];

const maxNameLength = 200;

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
  // Slice 10.1. `occupancy` returns a tenancy's parties as ids and no names —
  // correctly, since a name is this module's fact and not the join's — so the
  // admin unit view needs something to turn a handful of ids into people.
  getPeople(ids: string[]): Promise<Person[]>;
  listPhones(personId: string): Promise<PhoneLink[]>;
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
          const personId = validId(input?.personId, 'personId');
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
      return toPerson(row);
    },

    async getPeople(ids) {
      // Batch, because the caller's shape is a list: a unit with a tenant, a
      // co-tenant and a guarantor is one query rather than three.
      if (ids.length === 0) {
        return [];
      }
      const wanted = ids.map((id, index) => validId(id, `ids[${index}]`));
      const found = await pool.query<PersonRow>(
        `SELECT p.id, p.display_name, p.language,
                coalesce(
                  array_agg(k.kind ORDER BY k.kind) FILTER (WHERE k.kind IS NOT NULL),
                  '{}'
                ) AS kinds
           FROM identity_people p
           LEFT JOIN identity_person_kinds k ON k.person_id = p.id
          WHERE p.id = ANY($1::uuid[])
          GROUP BY p.id, p.display_name, p.language`,
        [wanted],
      );
      // An unknown id is absent from the result rather than an error: the caller
      // is rendering a page, and one dangling party should leave the other two
      // on screen. Order is not promised — callers index by id.
      return found.rows.map(toPerson);
    },

    async listPhones(personId) {
      const id = validId(personId, 'personId');
      // No not_found on a miss, though this takes a system id: a person with no
      // numbers is a true `[]` about someone who exists.
      const found = await pool.query<{ person_id: string; phone: string }>(
        `SELECT person_id, phone FROM identity_phones
          WHERE person_id = $1
          ORDER BY created_at, phone`,
        [id],
      );
      return found.rows.map((row) => ({
        personId: row.person_id,
        phone: row.phone,
      }));
    },
  };
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    displayName: row.display_name,
    language: row.language,
    kinds: row.kinds,
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

// Shape validation lives in the kernel (`kernel/validate.ts`). What stays here
// is the part that knows identity's vocabulary.
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
