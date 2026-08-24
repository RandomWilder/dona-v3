import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { createIdentity } from '../identity/contract.ts';
import { fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import { createOccupancy } from '../occupancy/contract.ts';
import { createPortfolio } from '../portfolio/contract.ts';
import { importTenants } from './contract.ts';

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'pilot-sample.csv',
);

const header =
  'building_name,city,street,house_number,unit_label,floor,starts_on,ends_on,parking_spot,storage_unit,person_name,phone,role';

// The database persists between runs, so every test invents its own street and
// its own phone numbers.
function uniqueFile(rows: string[]): { text: string; street: string } {
  const street = `הרצל ${newId()}`;
  const text = [
    header,
    ...rows.map((row) => row.replace('{street}', street)),
  ].join('\n');
  return { text, street };
}

function uniquePhone(): string {
  return `05${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0')}`;
}

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

async function countsFor(pool: Pool, street: string) {
  const row = await pool.query<{
    buildings: string;
    units: string;
    tenancies: string;
    parties: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM portfolio_buildings WHERE street = $1) AS buildings,
       (SELECT count(*)::text FROM portfolio_units u
          JOIN portfolio_buildings b ON b.id = u.building_id
         WHERE b.street = $1) AS units,
       (SELECT count(*)::text FROM occupancy_tenancies t
          JOIN portfolio_units u ON u.id = t.unit_id
          JOIN portfolio_buildings b ON b.id = u.building_id
         WHERE b.street = $1) AS tenancies,
       (SELECT count(*)::text FROM occupancy_parties p
          JOIN occupancy_tenancies t ON t.id = p.tenancy_id
          JOIN portfolio_units u ON u.id = t.unit_id
          JOIN portfolio_buildings b ON b.id = u.building_id
         WHERE b.street = $1) AS parties`,
    [street],
  );
  return row.rows[0];
}

describe('tenant import', () => {
  it('lands a household through the module contracts', async (t) => {
    await withPool(t, async (pool) => {
      const dana = uniquePhone();
      const avi = uniquePhone();
      const { text, street } = uniqueFile([
        `בית,תל אביב,{street},12,3,1,2026-09-01,2027-08-31,P-14,M-7,דנה,${dana},tenant`,
        `בית,תל אביב,{street},12,3,1,2026-09-01,2027-08-31,P-14,M-7,דנה,${dana},billed`,
        `בית,תל אביב,{street},12,3,1,2026-09-01,2027-08-31,P-14,M-7,אבי,${avi},guarantor`,
      ]);

      const report = await importTenants(text, { pool }, { commit: true });
      assert.deepEqual(
        {
          read: report.read,
          applied: report.applied,
          rejected: report.rejected,
        },
        { read: 3, applied: 3, rejected: [] },
      );

      const counts = await countsFor(pool, street);
      // One building, one unit, one tenancy -- three rows describing one
      // household, not three households.
      assert.deepEqual(counts, {
        buildings: '1',
        units: '1',
        tenancies: '1',
        parties: '3',
      });
    });
  });

  // The importer proving itself through 7.1's chain rather than through its
  // own bookkeeping.
  it('makes an imported phone resolve to the imported unit', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const phone = uniquePhone();
      const guarantor = uniquePhone();
      const { text } = uniqueFile([
        `בית,תל אביב,{street},12,7,2,2026-09-01,2027-08-31,P-2,,דנה,${phone},tenant`,
        `בית,תל אביב,{street},12,7,2,2026-09-01,2027-08-31,P-2,,אבי,${guarantor},guarantor`,
      ]);
      await importTenants(text, { pool, clock }, { commit: true });

      const identity = createIdentity({ pool, clock });
      const portfolio = createPortfolio({ pool, clock });
      const occupancy = createOccupancy({ pool, clock, identity, portfolio });

      const resolved = await occupancy.resolveByPhone(phone);
      assert.equal(resolved?.tenancies.length, 1);
      assert.equal(resolved?.tenancies[0]?.unit.unit.label, '7');
      assert.equal(resolved?.tenancies[0]?.tenancy.parkingSpot, 'P-2');
      assert.equal(resolved?.tenancies[0]?.access, 'resident');

      // And the guarantor reaches the same tenancy without a tenant's access.
      const his = await occupancy.resolveByPhone(guarantor);
      assert.equal(
        his?.tenancies[0]?.tenancy.id,
        resolved?.tenancies[0]?.tenancy.id,
      );
      assert.equal(his?.tenancies[0]?.access, 'party');
    });
  });

  // The whole point of the slice.
  it('changes nothing on a second run of the same file', async (t) => {
    await withPool(t, async (pool) => {
      const { text, street } = uniqueFile([
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,דנה,${uniquePhone()},tenant`,
        `בית,תל אביב,{street},12,4,1,2026-07-15,,,,יוסי,${uniquePhone()},tenant`,
      ]);

      const first = await importTenants(text, { pool }, { commit: true });
      const after = await countsFor(pool, street);
      const second = await importTenants(text, { pool }, { commit: true });

      assert.deepEqual(second, first);
      assert.deepEqual(await countsFor(pool, street), after);
    });
  });

  it('re-sorting the file does not mint second people', async (t) => {
    await withPool(t, async (pool) => {
      const one = uniquePhone();
      const two = uniquePhone();
      const rows = [
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,דנה,${one},tenant`,
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,אבי,${two},guarantor`,
      ];
      const street = `הרצל ${newId()}`;
      const build = (order: string[]) =>
        [header, ...order.map((r) => r.replace('{street}', street))].join('\n');

      await importTenants(build(rows), { pool }, { commit: true });
      // Same rows, opposite order: the intent key is the phone, not the line.
      await importTenants(
        build([...rows].reverse()),
        { pool },
        { commit: true },
      );

      const people = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM identity_people p
           JOIN identity_phones ph ON ph.person_id = p.id
          WHERE ph.phone = ANY($1)`,
        [[`+972${one.slice(1)}`, `+972${two.slice(1)}`]],
      );
      assert.equal(people.rows[0]?.count, '2');
    });
  });

  it('reports rejects by line without failing the run', async (t) => {
    await withPool(t, async (pool) => {
      const good = uniquePhone();
      const { text, street } = uniqueFile([
        `בית,תל אביב,{street},12,3,1,2026-02-30,,,,תאריך,${uniquePhone()},tenant`,
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,טוב,${good},tenant`,
        `בית,תל אביב,{street},12,4,1,2026-09-01,,,,תפקיד,${uniquePhone()},landlord`,
      ]);

      const report = await importTenants(text, { pool }, { commit: true });
      assert.equal(report.applied, 1);
      assert.deepEqual(
        report.rejected.map((r) => r.line),
        [2, 4],
      );
      assert.match(report.rejected[0]?.reason ?? '', /starts_on/);
      assert.match(report.rejected[1]?.reason ?? '', /role/);
      // The good row between two bad ones still landed.
      assert.equal((await countsFor(pool, street))?.parties, '1');
    });
  });

  it('writes nothing on a dry run, then the same text lands', async (t) => {
    await withPool(t, async (pool) => {
      const { text, street } = uniqueFile([
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,דנה,${uniquePhone()},tenant`,
      ]);

      const dry = await importTenants(text, { pool });
      assert.equal(dry.committed, false);
      assert.equal(dry.applied, 1);
      assert.deepEqual(await countsFor(pool, street), {
        buildings: '0',
        units: '0',
        tenancies: '0',
        parties: '0',
      });

      const wet = await importTenants(text, { pool }, { commit: true });
      assert.equal(wet.committed, true);
      assert.deepEqual(await countsFor(pool, street), {
        buildings: '1',
        units: '1',
        tenancies: '1',
        parties: '1',
      });
    });
  });

  it('refuses a file missing a required column', async (t) => {
    await withPool(t, async (pool) => {
      await assert.rejects(
        importTenants('city,street\nתל אביב,הרצל\n', { pool }),
        (error: KernelError) => {
          assert.equal(error.code, 'invalid');
          assert.ok(Array.isArray(error.details?.missing));
          return true;
        },
      );
    });
  });

  // After a ragged row every later line number is meaningless, and line
  // numbers are the whole value of the reject list.
  it('aborts on a structural failure rather than reporting rejects', async (t) => {
    await withPool(t, async (pool) => {
      const { text } = uniqueFile([
        `בית,תל אביב,{street},12,3,1,2026-09-01,,,,דנה,${uniquePhone()},tenant`,
      ]);
      await assert.rejects(
        importTenants(`${text}\nonly,three,fields\n`, { pool }),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  });

  // The shipped fixture has to stay valid, or the first thing anyone runs
  // against a fresh database is broken.
  it('imports the shipped pilot fixture', async (t) => {
    await withPool(t, async (pool) => {
      const report = await importTenants(
        readFileSync(fixture, 'utf8'),
        { pool },
        { commit: true },
      );
      assert.equal(report.read, 11);
      assert.equal(report.applied, 6);
      assert.deepEqual(
        report.rejected.map((r) => r.line),
        [8, 9, 10, 11, 12],
      );
    });
  });
});
