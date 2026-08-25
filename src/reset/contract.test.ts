import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import {
  assertNotProduction,
  classifyTables,
  preservedTables,
  truncatedTables,
} from './contract.ts';

// What is deliberately not tested here: `resetDomainData` actually running.
// `node --test` runs files in parallel against one database, so a test that
// truncated identity_people would empty the tables the identity, occupancy and
// import suites are using at that moment — a test that breaks its neighbours is
// worse than no test. The truncate is proved where it is used, on staging, by
// slice 11.1's Verify step.
//
// What is tested is the part that would go wrong silently and could not be seen
// on staging: a table nobody classified.

async function withPool(
  t: { skip(reason: string): void },
  work: (pool: Pool) => Promise<void>,
): Promise<void> {
  const pool = await migratedPoolOrNull();
  if (!pool) {
    t.skip(skipReason);
    return;
  }
  try {
    await work(pool);
  } finally {
    await pool.end();
  }
}

describe('reset', () => {
  it('classifies every table in the database', async (t) => {
    await withPool(t, async (pool) => {
      const { unclassified, missing } = await classifyTables(pool);
      // A new migration lands a table on one of the two lists, on purpose. The
      // failure message names it, because the decision — emptied or preserved —
      // belongs to whoever added it.
      assert.deepEqual(unclassified, []);
      assert.deepEqual(missing, []);
    });
  });

  it('keeps the two lists disjoint', () => {
    const overlap = truncatedTables.filter((table) =>
      (preservedTables as readonly string[]).includes(table),
    );
    assert.deepEqual(overlap, []);
  });

  it('refuses a production connection string', () => {
    assert.throws(
      () =>
        assertNotProduction(
          'postgres://dona:x@/dona?host=/cloudsql/dona-v3:me-west1:dona-prod',
        ),
      /production/,
    );
  });

  it('allows a staging connection string', () => {
    assertNotProduction(
      'postgres://dona:x@/dona?host=/cloudsql/dona-v3:me-west1:dona-staging',
    );
  });
});
