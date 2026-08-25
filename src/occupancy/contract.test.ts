import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createIdentity } from '../identity/contract.ts';
import { type Clock, fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import { createPortfolio } from '../portfolio/contract.ts';
import { type Actor, createOccupancy } from './contract.ts';

// Contract tests: every command goes through contract.ts — occupancy's, and
// identity's and portfolio's too, since this module composes them. The pool is
// used only to inspect what the commands left behind, never to shortcut one.
const actor: Actor = { kind: 'staff', id: 'contract-test' };

// The database persists between runs, so every test invents its own everything.
function uniqueAddress() {
  return {
    name: 'בית הרצל',
    city: 'תל אביב',
    street: `הרצל ${newId()}`,
    houseNumber: '12',
  };
}

// A valid Israeli mobile: 0 5 then eight digits.
function uniquePhone(): string {
  const digits = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0');
  return `05${digits}`;
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

// The three modules as one caller sees them, on one clock.
function world(pool: Pool, clock?: Clock) {
  const identity = createIdentity({ pool, clock });
  const portfolio = createPortfolio({ pool, clock });
  const occupancy = createOccupancy({ pool, clock, identity, portfolio });
  return { identity, portfolio, occupancy };
}

// One person with one phone, in one call.
async function personWithPhone(
  identity: ReturnType<typeof createIdentity>,
  displayName: string,
): Promise<{ id: string; phone: string }> {
  const person = await identity.addPerson(
    { intentKey: `contract-test:${newId()}`, displayName, kinds: ['tenant'] },
    actor,
  );
  const phone = uniquePhone();
  await identity.addPhone({ personId: person.id, phone }, actor);
  return { id: person.id, phone };
}

describe('occupancy contract', () => {
  // The first half of Done when, and the sentence the whole week is built on.
  it('resolves phone → person → unit → current occupancy', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3', floor: 1 },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        {
          unitId: unit.id,
          startsOn: '2026-09-01',
          endsOn: '2027-08-31',
          parkingSpot: 'P-14',
          storageUnit: 'M-7',
        },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );

      // The number arrives from WhatsApp in a spelling nobody chose. identity
      // owns the normalisation, so the chain does not care.
      const resolved = await occupancy.resolveByPhone(
        `+972-${tenant.phone.slice(1)}`,
      );
      assert.ok(resolved);
      assert.equal(resolved.person.id, tenant.id);
      assert.equal(resolved.person.displayName, 'דנה כהן');
      assert.equal(resolved.tenancies.length, 1);

      const [only] = resolved.tenancies;
      assert.ok(only);
      assert.equal(only.tenancy.id, tenancy.id);
      assert.deepEqual(only.roles, ['tenant']);
      assert.equal(only.access, 'resident');
      assert.equal(only.unit.unit.id, unit.id);
      assert.equal(only.unit.unit.label, '3');
      assert.equal(only.unit.building.id, building.id);
      // Reassignable, so they belong to the tenancy and travel with it.
      assert.equal(only.tenancy.parkingSpot, 'P-14');
      assert.equal(only.tenancy.storageUnit, 'M-7');
    });
  });

  // The second half of Done when, and the reason this slice got its isolation
  // tests before it got features.
  it('does not let one tenancy reach another', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      // Two households behind two doors on one staircase — the case where a
      // sloppy join is most likely to answer about the wrong flat.
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unitThree = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const unitFour = await portfolio.addUnit(
        { buildingId: building.id, label: '4' },
        actor,
      );

      const dana = await personWithPhone(identity, 'דנה כהן');
      const yossi = await personWithPhone(identity, 'יוסי לוי');

      const three = await occupancy.openTenancy(
        { unitId: unitThree.id, startsOn: '2026-09-01' },
        actor,
      );
      const four = await occupancy.openTenancy(
        { unitId: unitFour.id, startsOn: '2026-09-01' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: three.id, personId: dana.id, role: 'tenant' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: four.id, personId: yossi.id, role: 'tenant' },
        actor,
      );

      const hers = await occupancy.resolveByPhone(dana.phone);
      const his = await occupancy.resolveByPhone(yossi.phone);
      assert.equal(hers?.tenancies.length, 1);
      assert.equal(his?.tenancies.length, 1);
      assert.equal(hers?.tenancies[0]?.unit.unit.id, unitThree.id);
      assert.equal(his?.tenancies[0]?.unit.unit.id, unitFour.id);
      // Said the other way round, because this is the assertion that matters.
      assert.notEqual(hers?.tenancies[0]?.tenancy.id, four.id);
      assert.notEqual(his?.tenancies[0]?.tenancy.id, three.id);
    });
  });

  // The guarantor of the שטר חוב: a party to the tenancy who does not live
  // there. Same tenancy, two different answers.
  it('gives a guarantor his tenancy without giving him a tenant s access', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      const building = await portfolio.addBuilding(
        { ...uniqueAddress(), accessNotes: 'קוד כניסה 4471' },
        actor,
      );
      const unit = await portfolio.addUnit(
        {
          buildingId: building.id,
          label: '3',
          accessNotes: 'מפתח אצל השכן',
        },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const guarantor = await personWithPhone(identity, 'אבי כהן');
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );
      // She also pays, so she holds two roles on the one link.
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'billed' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: guarantor.id, role: 'guarantor' },
        actor,
      );

      const hers = await occupancy.resolveByPhone(tenant.phone);
      const his = await occupancy.resolveByPhone(guarantor.phone);

      // He reaches the tenancy — he is a party to it, and pretending otherwise
      // would lose the fact that he signed.
      assert.equal(his?.tenancies.length, 1);
      assert.equal(his?.tenancies[0]?.tenancy.id, tenancy.id);
      assert.deepEqual(his?.tenancies[0]?.roles, ['guarantor']);
      // And he does not reach a tenant's access.
      assert.equal(his?.tenancies[0]?.access, 'party');
      assert.equal(hers?.tenancies[0]?.access, 'resident');
      assert.deepEqual(hers?.tenancies[0]?.roles, ['tenant', 'billed']);

      // Neither of them gets an entry code out of a resolution, whatever their
      // access says. The read never asks portfolio for one.
      for (const resolution of [hers, his]) {
        const serialised = JSON.stringify(resolution);
        assert.equal(serialised.includes('4471'), false);
        assert.equal(serialised.includes('מפתח'), false);
      }
    });
  });

  it('stops resolving a tenancy once it has ended', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );
      assert.equal(
        (await occupancy.resolveByPhone(tenant.phone))?.tenancies.length,
        1,
      );

      await occupancy.endTenancy(
        { tenancyId: tenancy.id, endsOn: '2026-09-10' },
        actor,
      );

      // Still a person the system knows — she has simply stopped living there.
      // An empty list is not the same answer as null.
      const after = await occupancy.resolveByPhone(tenant.phone);
      assert.ok(after);
      assert.equal(after.person.id, tenant.id);
      assert.deepEqual(after.tenancies, []);
    });
  });

  it('does not resolve a tenancy that has not started', async (t) => {
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-10-01' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );

      assert.deepEqual(
        (await occupancy.resolveByPhone(tenant.phone))?.tenancies,
        [],
      );
    });
  });

  // Inclusive at both ends, and read on Israeli dates. Israel runs ahead of
  // UTC, so at 21:30Z it is already 00:30 the next morning in Tel Aviv — the
  // three hours in which a UTC comparison is answering about the wrong day.
  it('reads current on Israeli dates, not on UTC', async (t) => {
    await withPool(t, async (pool) => {
      const pool_ = pool;
      const setup = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool_, setup);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01', endsOn: '2026-09-30' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );

      const at = async (instant: string) => {
        const { occupancy: asOf } = world(pool_, fixedClock(new Date(instant)));
        const resolved = await asOf.resolveByPhone(tenant.phone);
        return resolved?.tenancies.length ?? -1;
      };

      // The last day is inclusive, and so is the first.
      assert.equal(await at('2026-09-30T06:00:00Z'), 1);
      assert.equal(await at('2026-09-01T06:00:00Z'), 1);
      // 21:00 on 30 Sep in Tel Aviv — the last evening, and still hers.
      assert.equal(await at('2026-09-30T18:00:00Z'), 1);

      // The two that discriminate. 21:30Z is 00:30 the next morning in Tel
      // Aviv, and UTC would get each of them wrong in the opposite direction.
      //
      // 00:30 on 1 Oct: her lease is over, though UTC still says 30 Sep.
      assert.equal(await at('2026-09-30T21:30:00Z'), 0);
      // 00:30 on 1 Sep, the night she moved in: hers, though UTC says 31 Aug.
      assert.equal(await at('2026-08-31T21:30:00Z'), 1);
      // And a day either side, where UTC and Tel Aviv agree.
      assert.equal(await at('2026-10-01T06:00:00Z'), 0);
      assert.equal(await at('2026-08-31T06:00:00Z'), 0);
    });
  });

  it('reads a unit forward to the people in it', async (t) => {
    // The direction slice 10.1 needed and 7.1 did not build: the admin unit
    // view starts from a place, where resolveByPhone starts from a person.
    await withPool(t, async (pool) => {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool, clock);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const guarantor = await personWithPhone(identity, 'משה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );

      // Empty before anyone lives there — a vacancy, not an error.
      assert.equal(await occupancy.findCurrentTenancy(unit.id), null);

      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01', parkingSpot: 'B-12' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'billed' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: guarantor.id, role: 'guarantor' },
        actor,
      );

      const view = await occupancy.findCurrentTenancy(unit.id);
      assert.ok(view);
      assert.equal(view.tenancy.id, tenancy.id);
      assert.equal(view.tenancy.parkingSpot, 'B-12');
      assert.equal(view.unit.unit.id, unit.id);
      assert.equal(view.unit.building.id, building.id);

      // The same two-answers-one-tenancy 7.1 proved from the phone side: she
      // lives behind the door, he is only on the hook for it.
      const byPerson = new Map(view.parties.map((p) => [p.personId, p]));
      assert.deepEqual(byPerson.get(tenant.id)?.roles, ['tenant', 'billed']);
      assert.equal(byPerson.get(tenant.id)?.access, 'resident');
      assert.deepEqual(byPerson.get(guarantor.id)?.roles, ['guarantor']);
      assert.equal(byPerson.get(guarantor.id)?.access, 'party');

      // Names are not this read's to give: the page composes them through
      // identity, which is what keeps the join free of identity's facts.
      assert.equal('displayName' in (byPerson.get(tenant.id) ?? {}), false);
    });
  });

  it('finds no current tenancy on a unit whose lease has ended', async (t) => {
    await withPool(t, async (pool) => {
      const pool_ = pool;
      const setup = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const { identity, portfolio, occupancy } = world(pool_, setup);

      const tenant = await personWithPhone(identity, 'דנה כהן');
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01', endsOn: '2026-09-30' },
        actor,
      );
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: tenant.id, role: 'tenant' },
        actor,
      );

      const at = async (instant: string) => {
        const { occupancy: asOf } = world(pool_, fixedClock(new Date(instant)));
        return (await asOf.findCurrentTenancy(unit.id)) !== null;
      };

      // Not yet started, and after it ended.
      assert.equal(await at('2026-08-31T06:00:00Z'), false);
      assert.equal(await at('2026-10-01T06:00:00Z'), false);
      // Both ends inclusive.
      assert.equal(await at('2026-09-01T06:00:00Z'), true);
      assert.equal(await at('2026-09-30T06:00:00Z'), true);

      // The two that discriminate, pinned from each side as resolveByPhone's
      // are: 21:30Z is 00:30 the next morning in Tel Aviv, and both flip if the
      // AT TIME ZONE is dropped from the shared predicate.
      //
      // 00:30 on 1 Oct — the flat is empty, though UTC still says 30 Sep.
      assert.equal(await at('2026-09-30T21:30:00Z'), false);
      // 00:30 on 1 Sep, the night she moved in — hers, though UTC says 31 Aug.
      assert.equal(await at('2026-08-31T21:30:00Z'), true);
    });
  });

  it('rejects a unit id that is not an id', async (t) => {
    await withPool(t, async (pool) => {
      const { occupancy } = world(pool);
      await assert.rejects(
        () => occupancy.findCurrentTenancy('not-a-uuid'),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  });

  it('answers a number nobody holds with null, and a person with no tenancy with an empty list', async (t) => {
    await withPool(t, async (pool) => {
      const { identity, occupancy } = world(pool);

      assert.equal(await occupancy.resolveByPhone(uniquePhone()), null);

      // A vendor, an owner, a tenant who has not moved in yet.
      const known = await personWithPhone(identity, 'רן פרץ');
      const resolved = await occupancy.resolveByPhone(known.phone);
      assert.ok(resolved);
      assert.deepEqual(resolved.tenancies, []);
    });
  });

  it('reads a tenancy back whole, with its parties and its unit', async (t) => {
    await withPool(t, async (pool) => {
      const { identity, portfolio, occupancy } = world(pool);

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );
      const tenant = await personWithPhone(identity, 'דנה כהן');
      const guarantor = await personWithPhone(identity, 'אבי כהן');
      for (const role of ['tenant', 'billed'] as const) {
        await occupancy.addParty(
          { tenancyId: tenancy.id, personId: tenant.id, role },
          actor,
        );
      }
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: guarantor.id, role: 'guarantor' },
        actor,
      );

      const view = await occupancy.getTenancy(tenancy.id);
      assert.equal(view.tenancy.id, tenancy.id);
      assert.equal(view.unit.unit.id, unit.id);
      assert.deepEqual(
        [...view.parties].sort((a, b) => a.personId.localeCompare(b.personId)),
        [
          {
            personId: tenant.id,
            roles: ['tenant', 'billed'],
            access: 'resident',
          },
          { personId: guarantor.id, roles: ['guarantor'], access: 'party' },
        ].sort((a, b) => a.personId.localeCompare(b.personId)),
      );
    });
  });

  it('reports an unknown tenancy id as not_found, not null', async (t) => {
    await withPool(t, async (pool) => {
      const { occupancy } = world(pool);
      await assert.rejects(
        occupancy.getTenancy(newId()),
        (error: KernelError) => error.code === 'not_found',
      );
    });
  });

  // A tenancy *is* one unit and one start date, so a re-run of day 8's importer
  // must be a no-op rather than a second tenancy.
  it('treats one unit and one start date as one tenancy', async (t) => {
    await withPool(t, async (pool) => {
      const { identity, portfolio, occupancy } = world(pool);

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const first = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01', parkingSpot: 'P-14' },
        actor,
      );
      const again = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01', parkingSpot: 'ignored' },
        actor,
      );
      assert.deepEqual(again, first);

      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM occupancy_tenancies WHERE unit_id = $1',
        [unit.id],
      );
      assert.equal(rows.rows[0]?.count, '1');

      // And the same party twice is one row, as identity's kinds are.
      const person = await personWithPhone(identity, 'דנה כהן');
      const party = {
        tenancyId: first.id,
        personId: person.id,
        role: 'tenant' as const,
      };
      assert.deepEqual(
        await occupancy.addParty(party, actor),
        await occupancy.addParty(party, actor),
      );
      const parties = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM occupancy_parties WHERE tenancy_id = $1',
        [first.id],
      );
      assert.equal(parties.rows[0]?.count, '1');
    });
  });

  it('lets a tenancy be ended once and refuses to move the date silently', async (t) => {
    await withPool(t, async (pool) => {
      const { portfolio, occupancy } = world(pool);

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );

      const ended = await occupancy.endTenancy(
        { tenancyId: tenancy.id, endsOn: '2027-08-31' },
        actor,
      );
      assert.equal(ended.endsOn, '2027-08-31');

      // Saying the same thing twice is the same tenancy.
      assert.deepEqual(
        await occupancy.endTenancy(
          { tenancyId: tenancy.id, endsOn: '2027-08-31' },
          actor,
        ),
        ended,
      );

      // Saying a different thing is a correction, and a correction has to
      // announce itself rather than overwrite.
      await assert.rejects(
        occupancy.endTenancy(
          { tenancyId: tenancy.id, endsOn: '2027-09-30' },
          actor,
        ),
        (error: KernelError) => error.code === 'conflict',
      );
    });
  });

  it('writes created_at from the injected clock', async (t) => {
    await withPool(t, async (pool) => {
      const at = new Date('2026-09-15T09:00:00.000Z');
      const { identity, portfolio, occupancy } = world(pool, fixedClock(at));

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );
      const person = await personWithPhone(identity, 'דנה כהן');
      await occupancy.addParty(
        { tenancyId: tenancy.id, personId: person.id, role: 'tenant' },
        actor,
      );

      const rows = await pool.query<{ created_at: Date }>(
        `SELECT created_at FROM occupancy_tenancies WHERE id = $1
         UNION ALL
         SELECT created_at FROM occupancy_parties WHERE tenancy_id = $1`,
        [tenancy.id],
      );
      assert.equal(rows.rowCount, 2);
      for (const row of rows.rows) {
        assert.equal(row.created_at.toISOString(), at.toISOString());
      }
    });
  });

  it('audits every mutation and every refusal', async (t) => {
    await withPool(t, async (pool) => {
      const { portfolio, occupancy } = world(pool);

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );
      await assert.rejects(
        occupancy.addParty(
          { tenancyId: tenancy.id, personId: newId(), role: 'tenant' },
          actor,
        ),
      );
      await assert.rejects(
        occupancy.endTenancy({ tenancyId: tenancy.id, endsOn: 'soon' }, actor),
      );

      const onTenancy = await pool.query<{
        action: string;
        outcome: string;
        error_code: string | null;
      }>(
        'SELECT action, outcome, error_code FROM audit_log WHERE subject_id = $1',
        [tenancy.id],
      );
      // Compared as a set: `at` has millisecond resolution and these land
      // inside one, so ordering by it would be a coin toss.
      assert.deepEqual(
        onTenancy.rows
          .map((row) => `${row.action} ${row.outcome} ${row.error_code ?? '-'}`)
          .sort(),
        [
          'occupancy.addParty error not_found',
          'occupancy.endTenancy error invalid',
        ],
      );

      // openTenancy has no subject id — the tenancy it names may not exist yet,
      // and on a repeat the caller gets one whose id this call never minted.
      const onUnit = await pool.query<{ actor_kind: string; outcome: string }>(
        `SELECT actor_kind, outcome FROM audit_log
          WHERE action = 'occupancy.openTenancy' AND inputs->>'unitId' = $1`,
        [unit.id],
      );
      assert.deepEqual(onUnit.rows, [{ actor_kind: 'staff', outcome: 'ok' }]);
    });
  });

  it('rejects what a caller can get wrong, at the edge', async (t) => {
    await withPool(t, async (pool) => {
      const { identity, portfolio, occupancy } = world(pool);
      const invalid = (error: KernelError) => error.code === 'invalid';
      const notFound = (error: KernelError) => error.code === 'not_found';

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      const tenancy = await occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-09-01' },
        actor,
      );
      const person = await personWithPhone(identity, 'דנה כהן');

      await assert.rejects(
        occupancy.openTenancy(
          { unitId: 'not-an-id', startsOn: '2026-09-01' },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        occupancy.openTenancy({ unitId: unit.id, startsOn: '1.9.2026' }, actor),
        invalid,
      );
      // A term that ends before it begins is refused here as a sentence, and
      // by a CHECK constraint underneath.
      await assert.rejects(
        occupancy.openTenancy(
          { unitId: unit.id, startsOn: '2026-09-01', endsOn: '2026-08-31' },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        occupancy.openTenancy(
          { unitId: newId(), startsOn: '2026-09-01' },
          actor,
        ),
        notFound,
      );
      await assert.rejects(
        occupancy.addParty(
          {
            tenancyId: tenancy.id,
            personId: person.id,
            role: 'landlord' as 'tenant',
          },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        occupancy.addParty(
          { tenancyId: newId(), personId: person.id, role: 'tenant' },
          actor,
        ),
        notFound,
      );
      await assert.rejects(
        occupancy.endTenancy(
          { tenancyId: tenancy.id, endsOn: '2026-08-31' },
          actor,
        ),
        invalid,
      );
      await assert.rejects(occupancy.getTenancy('not-an-id'), invalid);
      // An unnormalisable number is identity's `invalid`, reached through this
      // module without being reinterpreted.
      await assert.rejects(occupancy.resolveByPhone('1800123456'), invalid);
    });
  });
});
