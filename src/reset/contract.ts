// The domain-data reset. A tool rather than a domain module, on the same terms
// as `import` (SPEC-import.md): it owns no tables and adds no invariants. It
// empties the tables the domain modules own so the importer can fill them again
// from a template we wrote.
//
// Why it exists: a database the contract tests have run against is the wrong
// ground for anything. The importer keys a person by phone, so validating a
// template against a dirty database returns the *wrong people* — three of five
// phone lookups, when it was measured. Test databases accumulate: the local one
// held 2,843 people and 2,721 buildings by day 11, and nothing removes them
// between runs. A command in the repo, rather than a cleanup someone does once
// by hand.
//
// Where the residue actually is, corrected on day 11 against a measurement:
// **the developer's laptop, and CI's throwaway service container — never
// staging.** Week 2 carried a note saying staging held ~1,291 test buildings and
// ~1,000 test people; it held one person and no buildings at all. CI runs
// against a Postgres service container on 127.0.0.1 that dies with the job
// (.github/workflows/ci.yml), and nothing but the app has ever reached staging's
// database. The hazard was real and its address was wrong.
//
// So on staging this is a seeder more than a cleaner: it makes the environment
// *be* the mock building we designed, repeatably, and it stays honest if that
// ever stops being true.

import type { Pool } from 'pg';
import { KernelError } from '../kernel/errors.ts';

// Emptied. The three domain modules' tables, plus the kernel's idempotency memo.
//
// `idempotency_keys` is on this list and belongs here: every key in it is
// `identity.addPerson:…`, `portfolio.addBuilding:…` or an occupancy equivalent,
// and each one memoizes an id that the truncation is about to delete. Staff auth
// does not use the store at all. Leaving it behind is the quiet way a re-seed
// goes wrong — the import returns a memoized person id, and the row it names is
// gone.
export const truncatedTables = [
  'identity_people',
  'identity_phones',
  'identity_person_kinds',
  'portfolio_buildings',
  'portfolio_units',
  'portfolio_assets',
  'occupancy_tenancies',
  'occupancy_parties',
  'occupancy_documents',
  // Slice 12.1. The clause text a document was cut into, and so a verbatim copy
  // of a real contract in a second place -- it goes when the document goes.
  // Both are in one TRUNCATE statement, which is what lets the chunk table's
  // ON DELETE RESTRICT stand without making a reset impossible.
  'occupancy_document_chunks',
  // Slice 12.2. In the same TRUNCATE as the chunks rather than left to the
  // ON DELETE CASCADE, because TRUNCATE does not cascade without being told to
  // -- and being told to would reach past this list into tables we promised not
  // to touch. Listing it here keeps the no-CASCADE rule and empties it anyway.
  'occupancy_chunk_embeddings',
  // Slice 13.1. The twin's fields, which quote the contract they were read out
  // of -- the rent's stated figure, the securities' amounts, the deductible
  // clauses' own words. A third place a real lease lives, so it empties with
  // the other two (tasks/fuses.md counts them). In the same TRUNCATE for the
  // same reason: its ON DELETE RESTRICT to the chunk would otherwise make a
  // reset impossible without a CASCADE this list refuses to use.
  'occupancy_lease_facts',
  'idempotency_keys',
] as const;

// What the truncate does *not* reach: the objects those document rows point at.
// They stay in the bucket, unreferenced, and that is the honest position rather
// than a gap nobody noticed — the bucket is versioned, deleting is the one
// operation this system has no path for, and a retention rule is Dona Dom's to
// set (docs/runbook-deploy.md, "Retention"). A reset therefore orphans objects
// on purpose, and week 6's deletion work is what will let it stop.

// Left alone, and this is the point of the slice rather than an afterthought:
// the staff logins are in use, and the week-2 audit trail is evidence of a demo
// that was run. `schema_migrations` would make the next boot re-run every
// migration.
export const preservedTables = [
  // Slice 12.2. Configuration, not domain data: the embedding model id and its
  // width are settings an environment was deliberately given, in the same class
  // as the staff logins and schema_migrations. A reset that wiped them would
  // re-seed a building and quietly change how the next lease is indexed.
  'config_settings',
  'staff_operators',
  'staff_sessions',
  'staff_login_attempts',
  'audit_log',
  'outbox',
  'scheduled_work',
  'schema_migrations',
] as const;

export interface ResetReport {
  // What was in each table before it was emptied, so the run says what it
  // destroyed rather than only that it finished.
  removed: Record<string, number>;
  // Counted after the truncate and compared with the count before it. A
  // preserved table that moved is a bug in the list above, and this is how it
  // would be caught rather than assumed.
  preserved: Record<string, number>;
}

// What a reset would remove and what it would keep, without removing anything.
// The dry run reads it through the same two lists the real run uses, so the
// preview cannot describe a different set of tables from the command.
export async function countTables(pool: Pool): Promise<ResetReport> {
  return {
    removed: await countRows(pool, truncatedTables),
    preserved: await countRows(pool, preservedTables),
  };
}

export async function resetDomainData(pool: Pool): Promise<ResetReport> {
  const removed = await countRows(pool, truncatedTables);
  const before = await countRows(pool, preservedTables);

  // One statement, one transaction, and deliberately no CASCADE: if a future
  // table ever references one of these and is not on the list above, this
  // fails loudly. CASCADE would instead reach through into the tables we
  // promised not to touch.
  await pool.query(`TRUNCATE ${truncatedTables.join(', ')}`);

  const preserved = await countRows(pool, preservedTables);
  const moved = preservedTables.filter(
    (table) => preserved[table] !== before[table],
  );
  if (moved.length > 0) {
    throw new KernelError('conflict', 'a preserved table lost rows', { moved });
  }

  return { removed, preserved };
}

// Refuses to run against production. This catches the direct case — running
// inside a prod container, or with prod's socket URL exported by hand. It
// cannot catch a proxied connection, where every URL is localhost: that guard
// lives in infra/reset-staging-data.sh, which reads the connection name out of
// the secret before it opens a tunnel to anything.
export function assertNotProduction(connectionString: string): void {
  if (/prod/i.test(connectionString)) {
    throw new KernelError(
      'invalid',
      'DATABASE_URL names production — this tool empties tables',
    );
  }
}

// Every table in the database is on exactly one of the two lists. Read-only, so
// it is safe beside the suites that run in parallel with it, and it is what
// makes a new migration a decision rather than an omission.
export async function classifyTables(pool: Pool): Promise<{
  unclassified: string[];
  missing: string[];
}> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const present = result.rows.map((row) => row.table_name);
  const classified = new Set<string>([...truncatedTables, ...preservedTables]);
  return {
    unclassified: present.filter((table) => !classified.has(table)).sort(),
    missing: [...classified].filter((table) => !present.includes(table)).sort(),
  };
}

async function countRows(
  pool: Pool,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Table names are the module-level constants above, never caller input.
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? '0');
  }
  return counts;
}
