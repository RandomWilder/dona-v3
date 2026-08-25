import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createIdentity } from '../identity/contract.ts';
import { type Clock, fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { createMemoryStore, type ObjectStore } from '../kernel/objects.ts';
import type { PdfPage, PdfText } from '../kernel/pdf.ts';
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

// The three modules as one caller sees them, on one clock. The document store
// is in memory: no test reaches the network, and none needs a bucket.
function world(pool: Pool, clock?: Clock, store?: ObjectStore, pdf?: PdfText) {
  const identity = createIdentity({ pool, clock });
  const portfolio = createPortfolio({ pool, clock });
  const occupancy = createOccupancy({
    pool,
    clock,
    identity,
    portfolio,
    store: store ?? createMemoryStore(),
    pdf: pdf ?? emptyPdf,
  });
  return { identity, portfolio, occupancy };
}

// A reader that hands back pages the test wrote, so no contract test opens a
// real PDF: what pdfjs does with bytes is pinned in src/kernel/pdf.test.ts, and
// what clause detection does with pages in internal/clauses.test.ts. What is
// left for this file is the command around them.
function pdfOf(pages: PdfPage[]): PdfText {
  return { pages: async () => pages, describe: () => 'fake' };
}

const emptyPdf: PdfText = pdfOf([]);

// Enough text for a page to be a page: below `minPageChars` of readable text a
// page is an image with a footer on it, which is a property of the chunker for
// its own tests to exercise rather than for these to trip over.
const pageFiller =
  'הצדדים מצהירים כי קראו את ההסכם, הבינו את תוכנו ואת מלוא התחייבויותיהם על פיו.';

// One right-aligned Hebrew line on a page, in the top-down coordinates the
// kernel adapter produces.
function pdfPage(number: number, lines: string[]): PdfPage {
  return {
    number,
    width: 595,
    height: 842,
    items: [...lines, pageFiller].map((text, index) => ({
      text,
      x: 150,
      y: 60 + index * 20,
      width: 340,
      height: 11,
      rightToLeft: true,
      endsLine: true,
    })),
  };
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
  // Slice 11.2. A document belongs to a tenancy, and the whole point of the
  // table is that it belongs to nothing else.
  describe('lease documents', () => {
    async function tenancyFor(pool: Pool, store?: ObjectStore, pdf?: PdfText) {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const world_ = world(pool, clock, store, pdf);
      const building = await world_.portfolio.addBuilding(
        uniqueAddress(),
        actor,
      );
      const unit = await world_.portfolio.addUnit(
        { buildingId: building.id, label: '4', floor: 1 },
        actor,
      );
      const tenancy = await world_.occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-01-01' },
        actor,
      );
      return { ...world_, building, unit, tenancy };
    }

    const pdf = () => Buffer.from('%PDF-1.7\nthe signed lease\n%%EOF');

    it('stores a lease and reads the same bytes back', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy, building, unit, tenancy } = await tenancyFor(pool);

        const document = await occupancy.attachDocument(
          {
            tenancyId: tenancy.id,
            kind: 'lease',
            contentType: 'application/pdf',
            bytes: pdf(),
          },
          actor,
        );

        assert.equal(document.tenancyId, tenancy.id);
        assert.equal(document.byteSize, pdf().length);
        // The place, by id, and nothing a person is called.
        assert.equal(
          document.objectPath,
          `leases/bldg-${building.id}/unit-${unit.id}/tenancy-${tenancy.id}/lease-${document.id}.pdf`,
        );

        const read = await occupancy.readDocument(document.id);
        assert.equal(read.bytes.toString(), pdf().toString());
        assert.equal(read.document.id, document.id);

        const listed = await occupancy.listDocuments(tenancy.id);
        assert.deepEqual(
          listed.map((row) => row.id),
          [document.id],
        );
      });
    });

    it("keeps one tenancy's documents out of another's list", async (t) => {
      await withPool(t, async (pool) => {
        const first = await tenancyFor(pool);
        const second = await tenancyFor(pool);

        const mine = await first.occupancy.attachDocument(
          {
            tenancyId: first.tenancy.id,
            kind: 'lease',
            contentType: 'application/pdf',
            bytes: pdf(),
          },
          actor,
        );
        await second.occupancy.attachDocument(
          {
            tenancyId: second.tenancy.id,
            kind: 'lease',
            contentType: 'application/pdf',
            bytes: pdf(),
          },
          actor,
        );

        // The scope every later read is filtered by, asserted here before
        // anything is built on top of it.
        const listed = await first.occupancy.listDocuments(first.tenancy.id);
        assert.deepEqual(
          listed.map((row) => row.id),
          [mine.id],
        );
      });
    });

    it('refuses a tenancy that does not exist', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy } = await tenancyFor(pool);
        await assert.rejects(
          occupancy.attachDocument(
            {
              tenancyId: newId(),
              kind: 'lease',
              contentType: 'application/pdf',
              bytes: pdf(),
            },
            actor,
          ),
          (error: KernelError) => error.code === 'not_found',
        );
      });
    });

    it('refuses anything that is not a PDF, and an empty file', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy, tenancy } = await tenancyFor(pool);
        const attach = (contentType: string, bytes: Buffer) =>
          occupancy.attachDocument(
            { tenancyId: tenancy.id, kind: 'lease', contentType, bytes },
            actor,
          );

        await assert.rejects(
          attach('image/jpeg', pdf()),
          (error: KernelError) => error.code === 'invalid',
        );
        await assert.rejects(
          attach('application/pdf', Buffer.alloc(0)),
          (error: KernelError) => error.code === 'invalid',
        );
        // Parameters are not the type: a browser may send a charset, and
        // rejecting that would refuse a legitimate upload.
        const ok = await attach('application/pdf; charset=binary', pdf());
        assert.equal(ok.contentType, 'application/pdf');
      });
    });

    it('leaves no row when the object could not be stored', async (t) => {
      await withPool(t, async (pool) => {
        // The ordering rule, asserted by breaking it: object first, row second,
        // so a failure leaves an orphan object rather than a lease the admin
        // can list and cannot open.
        const failing: ObjectStore = {
          put: async () => {
            throw new Error('bucket unreachable');
          },
          read: async () => {
            throw new Error('bucket unreachable');
          },
          describe: () => 'failing',
        };
        const { occupancy, tenancy } = await tenancyFor(pool, failing);

        await assert.rejects(
          occupancy.attachDocument(
            {
              tenancyId: tenancy.id,
              kind: 'lease',
              contentType: 'application/pdf',
              bytes: pdf(),
            },
            actor,
          ),
        );
        assert.deepEqual(await occupancy.listDocuments(tenancy.id), []);
      });
    });

    it('reports a missing object rather than serving an empty file', async (t) => {
      await withPool(t, async (pool) => {
        const store = createMemoryStore();
        const { occupancy, tenancy } = await tenancyFor(pool, store);
        const document = await occupancy.attachDocument(
          {
            tenancyId: tenancy.id,
            kind: 'lease',
            contentType: 'application/pdf',
            bytes: pdf(),
          },
          actor,
        );
        // A second store stands for the object having gone: the row is intact
        // and the bytes are not.
        const { occupancy: withEmptyStore } = await tenancyFor(
          pool,
          createMemoryStore(),
        );
        await assert.rejects(
          withEmptyStore.readDocument(document.id),
          (error: KernelError) => error.code === 'not_found',
        );
      });
    });
  });

  describe('lease chunks', () => {
    async function tenancyFor(pool: Pool, pdf: PdfText, store?: ObjectStore) {
      const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
      const shared = store ?? createMemoryStore();
      const world_ = world(pool, clock, shared, pdf);
      const building = await world_.portfolio.addBuilding(
        uniqueAddress(),
        actor,
      );
      const unit = await world_.portfolio.addUnit(
        { buildingId: building.id, label: '24', floor: 2 },
        actor,
      );
      const tenancy = await world_.occupancy.openTenancy(
        { unitId: unit.id, startsOn: '2026-01-01' },
        actor,
      );
      const document = await world_.occupancy.attachDocument(
        {
          tenancyId: tenancy.id,
          kind: 'lease',
          contentType: 'application/pdf',
          bytes: Buffer.from('%PDF-1.7\nthe signed lease\n%%EOF'),
        },
        actor,
      );
      return { ...world_, store: shared, unit, tenancy, document };
    }

    const lease = [
      pdfPage(1, [
        'נספח א׳ — פרטי העסקה',
        '3. תקופת השכירות היא 24 חודשים מיום המסירה.',
      ]),
      pdfPage(2, ['4. דמי השכירות ישולמו בכל 1 לחודש קלנדרי.']),
    ];

    it('cuts a document into clauses, each carrying its tenancy', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy, tenancy, document } = await tenancyFor(
          pool,
          pdfOf(lease),
        );

        const ingestion = await occupancy.ingestDocument(
          { documentId: document.id },
          actor,
        );
        assert.equal(ingestion.tenancyId, tenancy.id);
        assert.equal(ingestion.pages, 2);
        assert.equal(ingestion.chunks, 3);
        assert.deepEqual(ingestion.imageOnlyPages, []);

        // The same three facts on the document row. Returning them was not
        // enough -- the first cut of this slice did exactly that, and the
        // browser redirect dropped them, so no screen could say them again.
        const [stored] = await occupancy.listDocuments(tenancy.id);
        assert.ok(stored?.ingestedAt);
        assert.equal(stored?.pageCount, 2);
        assert.deepEqual(stored?.imageOnlyPages, []);

        const chunks = await occupancy.listChunks(document.id);
        assert.deepEqual(
          chunks.map((chunk) => chunk.ordinal),
          [0, 1, 2],
        );
        assert.deepEqual(
          chunks.map((chunk) => chunk.clauseRef),
          ['נספח א׳', 'נספח א׳ §3', 'נספח א׳ §4'],
        );
        // The column slice 12.2's every retrieval query filters on. It is
        // copied from the document row and never taken from a caller, which is
        // the whole reason it is a column here rather than a join away.
        for (const chunk of chunks) {
          assert.equal(chunk.tenancyId, tenancy.id);
          assert.equal(chunk.documentId, document.id);
        }
        // The page a human turns to when checking the citation.
        assert.equal(chunks[2]?.pageFrom, 2);
      });
    });

    it('replaces on a second pass rather than filing a second copy', async (t) => {
      await withPool(t, async (pool) => {
        const store = createMemoryStore();
        const { occupancy, document } = await tenancyFor(
          pool,
          pdfOf(lease),
          store,
        );
        await occupancy.ingestDocument({ documentId: document.id }, actor);

        // The same document read again — by a better reader, which is what a
        // re-ingest is for. Chunks are derived data with a natural key, unlike
        // a document, whose second upload is a correction and is kept (11.2).
        const { occupancy: reread } = world(
          pool,
          fixedClock(new Date('2026-09-16T09:00:00Z')),
          store,
          pdfOf([...lease, pdfPage(3, ['5. הודעה מוקדמת של 60 יום.'])]),
        );
        const again = await reread.ingestDocument(
          { documentId: document.id },
          actor,
        );

        assert.equal(again.chunks, 4);
        const chunks = await reread.listChunks(document.id);
        assert.equal(chunks.length, 4);
        assert.deepEqual(
          chunks.map((chunk) => chunk.ordinal),
          [0, 1, 2, 3],
        );
        assert.match(chunks[3]?.text ?? '', /60 יום/);

        // The row moved with them: a document saying it was read on Tuesday
        // beside chunks from Monday is a worse lie than either alone, which is
        // why both are written in one transaction.
        const [stored] = await reread.listDocuments(document.tenancyId);
        assert.equal(stored?.pageCount, 3);
        assert.equal(
          stored?.ingestedAt,
          new Date('2026-09-16T09:00:00Z').toISOString(),
        );
      });
    });

    it('names the pages it could not read', async (t) => {
      await withPool(t, async (pool) => {
        // Four pages of the real lease are images. Ingestion that dropped them
        // silently would return a lease four pages shorter than the lease —
        // OCR is week 3's stated cut line, so saying so is the whole answer.
        const { occupancy, document } = await tenancyFor(
          pool,
          pdfOf([
            pdfPage(1, ['1. מבוא.']),
            { number: 2, width: 595, height: 842, items: [] },
            { number: 3, width: 595, height: 842, items: [] },
          ]),
        );
        const ingestion = await occupancy.ingestDocument(
          { documentId: document.id },
          actor,
        );
        assert.deepEqual(ingestion.imageOnlyPages, [2, 3]);
        assert.equal(ingestion.pages, 3);
        assert.equal(ingestion.chunks, 1);

        const [stored] = await occupancy.listDocuments(ingestion.tenancyId);
        assert.deepEqual(stored?.imageOnlyPages, [2, 3]);
        assert.equal(stored?.pageCount, 3);
      });
    });

    it('has never been read until it is read', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy, tenancy } = await tenancyFor(pool, pdfOf(lease));
        const [before] = await occupancy.listDocuments(tenancy.id);
        // Null and not a zero: "nobody has read this" is a different fact from
        // "this was read and produced nothing", and a count cannot say which.
        assert.equal(before?.ingestedAt, null);
        assert.equal(before?.pageCount, null);
        assert.deepEqual(before?.imageOnlyPages, []);
      });
    });

    it('refuses a document id it never issued', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy } = await tenancyFor(pool, pdfOf(lease));
        await assert.rejects(
          occupancy.ingestDocument({ documentId: newId() }, actor),
          (error: KernelError) => error.code === 'not_found',
        );
      });
    });

    it('reports a gone object instead of a lease with nothing in it', async (t) => {
      await withPool(t, async (pool) => {
        const { document } = await tenancyFor(pool, pdfOf(lease));
        // A second store stands for the object having gone: the row is intact
        // and the bytes are not. Zero chunks would read as a lease that says
        // nothing, which is the one answer that must not be possible.
        const { occupancy: withEmptyStore } = world(
          pool,
          undefined,
          createMemoryStore(),
          pdfOf(lease),
        );
        await assert.rejects(
          withEmptyStore.ingestDocument({ documentId: document.id }, actor),
          (error: KernelError) => error.code === 'not_found',
        );
        assert.deepEqual(await withEmptyStore.listChunks(document.id), []);
      });
    });

    it('audits the run without copying the lease into the audit row', async (t) => {
      await withPool(t, async (pool) => {
        const { occupancy, document } = await tenancyFor(pool, pdfOf(lease));
        await occupancy.ingestDocument({ documentId: document.id }, actor);
        await occupancy
          .ingestDocument({ documentId: newId() }, actor)
          .catch(() => {});

        const rows = await pool.query<{
          outcome: string;
          error_code: string | null;
          inputs: Record<string, unknown>;
        }>(
          `SELECT outcome, error_code, inputs FROM audit_log
            WHERE action = 'occupancy.ingestDocument' AND subject_id = $1`,
          [document.id],
        );
        assert.deepEqual(
          rows.rows.map((row) => `${row.outcome} ${row.error_code ?? '-'}`),
          ['ok -'],
        );
        // The document, and nothing out of it: the clause text is a verbatim
        // copy of a real contract, and a copy in audit_log would be one more
        // place it has to be deleted from at sign-off (tasks/fuses.md).
        assert.deepEqual(rows.rows[0]?.inputs, { documentId: document.id });

        const failed = await pool.query<{ error_code: string | null }>(
          `SELECT error_code FROM audit_log
            WHERE action = 'occupancy.ingestDocument' AND outcome = 'error'`,
        );
        assert.ok(failed.rows.some((row) => row.error_code === 'not_found'));
      });
    });
  });
});
