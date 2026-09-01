import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { createCatalog } from '../catalog/contract.ts';
import { createChannel } from '../channel/contract.ts';
import { createIdentity } from '../identity/contract.ts';
import { fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import { createOccupancy } from '../occupancy/contract.ts';
import { createPortfolio } from '../portfolio/contract.ts';
import {
  createStaffCommands,
  type Session,
  type StaffCommands,
  type StaffRole,
} from './contract.ts';
import { createStaffAuth } from './internal/auth.ts';

// Contract tests: every command goes through contract.ts. The pool is used only
// to inspect what the commands left behind — and, here, what they did not.
const password = 'correct-horse-battery';

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

function uniqueAddress() {
  return {
    name: 'בית הרצל',
    city: 'תל אביב',
    street: `הרצל ${newId()}`,
    houseNumber: '12',
  };
}

function uniquePhone(): string {
  const digits = Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0');
  return `05${digits}`;
}

// The modules as the admin panel sees them: the domain modules injected as
// their contract types, behind one guarded surface.
function world(pool: Pool): StaffCommands {
  const clock = fixedClock(new Date('2026-09-15T09:00:00Z'));
  const occupancy = createOccupancy({
    pool,
    clock,
    identity: createIdentity({ pool, clock }),
    portfolio: createPortfolio({ pool, clock }),
  });
  return createStaffCommands({
    pool,
    clock,
    identity: createIdentity({ pool, clock }),
    portfolio: createPortfolio({ pool, clock }),
    occupancy,
    // No source and no embedder: nothing in *this* file asks a question, and a
    // catalog that would refuse to sync is the honest stand-in for one. The
    // ordering rule has its own tests in src/channel/.
    channel: createChannel({
      occupancy,
      catalog: createCatalog({ pool, clock }),
    }),
  });
}

// A real logged-in session, not a hand-made object: the role the guard reads
// has to be the one that survived the round trip through the database.
async function sessionFor(pool: Pool, role: StaffRole): Promise<Session> {
  const auth = createStaffAuth(pool);
  const email = `staff-${newId()}@dona.test`;
  await auth.createOperator({ email, password, role });
  return auth.login(email, password);
}

// Every mutating command the system has today, each with an input that would
// succeed if the role allowed it — so a refusal is about the role and nothing
// else. Ids are filled in from a world built by an admin first.
interface Attempted {
  intentKey: string;
  phone: string;
  address: ReturnType<typeof uniqueAddress>;
  unitLabel: string;
}

interface Fixtures {
  personId: string;
  buildingId: string;
  unitId: string;
  tenancyId: string;
  otherPersonId: string;
}

interface Attempt {
  name: string;
  run: () => Promise<unknown>;
}

// Every mutating command the system has today, each with an input that would
// succeed if the role allowed it — so a refusal is about the role and nothing
// else. The inputs are built once, up front, so the test can afterwards look
// for exactly the rows they would have written.
function everyMutation(
  staff: StaffCommands,
  session: Session,
  fixtures: Fixtures,
): { commands: Attempt[]; attempted: Attempted } {
  const attempted: Attempted = {
    intentKey: `staff-contract:${newId()}`,
    phone: uniquePhone(),
    address: uniqueAddress(),
    unitLabel: newId(),
  };
  const commands: Attempt[] = [
    {
      name: 'addPerson',
      run: () =>
        staff.addPerson(
          {
            intentKey: attempted.intentKey,
            displayName: 'דנה כהן',
            kinds: ['tenant'],
          },
          session,
        ),
    },
    {
      name: 'addPhone',
      run: () =>
        staff.addPhone(
          { personId: fixtures.personId, phone: attempted.phone },
          session,
        ),
    },
    {
      name: 'addBuilding',
      run: () => staff.addBuilding(attempted.address, session),
    },
    {
      name: 'addUnit',
      run: () =>
        staff.addUnit(
          {
            buildingId: fixtures.buildingId,
            label: attempted.unitLabel,
            floor: 2,
          },
          session,
        ),
    },
    {
      name: 'addAsset',
      run: () =>
        staff.addAsset(
          { buildingId: fixtures.buildingId, kind: 'boiler' },
          session,
        ),
    },
    {
      name: 'openTenancy',
      run: () =>
        staff.openTenancy(
          { unitId: fixtures.unitId, startsOn: '2027-01-01' },
          session,
        ),
    },
    {
      name: 'addParty',
      run: () =>
        staff.addParty(
          {
            tenancyId: fixtures.tenancyId,
            personId: fixtures.otherPersonId,
            role: 'guarantor',
          },
          session,
        ),
    },
    {
      name: 'endTenancy',
      run: () =>
        staff.endTenancy(
          { tenancyId: fixtures.tenancyId, endsOn: '2027-08-31' },
          session,
        ),
    },
  ];
  return { commands, attempted };
}

// Built by an admin, so the viewer's attempts below have real ids to aim at —
// a refusal on a bad id would prove nothing about roles.
async function buildWorld(
  staff: StaffCommands,
  admin: Session,
): Promise<Fixtures> {
  const person = await staff.addPerson(
    {
      intentKey: `staff-contract:${newId()}`,
      displayName: 'יוסי לוי',
      kinds: ['tenant'],
    },
    admin,
  );
  const other = await staff.addPerson(
    {
      intentKey: `staff-contract:${newId()}`,
      displayName: 'רות לוי',
      kinds: ['tenant'],
    },
    admin,
  );
  const building = await staff.addBuilding(uniqueAddress(), admin);
  const unit = await staff.addUnit(
    { buildingId: building.id, label: '4', floor: 1 },
    admin,
  );
  const tenancy = await staff.openTenancy(
    { unitId: unit.id, startsOn: '2026-09-01' },
    admin,
  );
  return {
    personId: person.id,
    otherPersonId: other.id,
    buildingId: building.id,
    unitId: unit.id,
    tenancyId: tenancy.id,
  };
}

// Scoped to this test's own ids and to the exact rows the refused commands
// would have written. Counting whole tables would be counting other test files'
// work too: `node --test` runs them in parallel against one database.
async function scopedCounts(
  pool: Pool,
  fixtures: Fixtures,
  attempted: Attempted,
): Promise<Record<string, number>> {
  const queries: Record<string, [string, unknown[]]> = {
    // addPerson keys on the intent through the kernel, so the key is the trace.
    personIntent: [
      'SELECT count(*)::text AS n FROM idempotency_keys WHERE key LIKE $1',
      [`%${attempted.intentKey}%`],
    ],
    phonesForPerson: [
      'SELECT count(*)::text AS n FROM identity_phones WHERE person_id = $1',
      [fixtures.personId],
    ],
    buildingsOnStreet: [
      'SELECT count(*)::text AS n FROM portfolio_buildings WHERE street = $1',
      [attempted.address.street],
    ],
    unitsInBuilding: [
      'SELECT count(*)::text AS n FROM portfolio_units WHERE building_id = $1',
      [fixtures.buildingId],
    ],
    assetsInBuilding: [
      'SELECT count(*)::text AS n FROM portfolio_assets WHERE building_id = $1',
      [fixtures.buildingId],
    ],
    tenanciesInUnit: [
      'SELECT count(*)::text AS n FROM occupancy_tenancies WHERE unit_id = $1',
      [fixtures.unitId],
    ],
    partiesOnTenancy: [
      'SELECT count(*)::text AS n FROM occupancy_parties WHERE tenancy_id = $1',
      [fixtures.tenancyId],
    ],
    // endTenancy writes a date rather than a row, so a count of rows would miss
    // it entirely.
    tenancyEnded: [
      `SELECT count(*)::text AS n FROM occupancy_tenancies
        WHERE id = $1 AND ends_on IS NOT NULL`,
      [fixtures.tenancyId],
    ],
  };
  const counts: Record<string, number> = {};
  for (const [name, [sql, params]] of Object.entries(queries)) {
    const result = await pool.query<{ n: string }>(sql, params);
    counts[name] = Number(result.rows[0].n);
  }
  return counts;
}

describe('staff commands', () => {
  // Done when, and the whole point of the slice: the refusal is server-side, on
  // the command itself, and the UI is nowhere in this test.
  it('refuses a viewer every mutating command, and changes nothing', async (t) => {
    await withPool(t, async (pool) => {
      const staff = world(pool);
      const admin = await sessionFor(pool, 'admin');
      const fixtures = await buildWorld(staff, admin);

      const viewer = await sessionFor(pool, 'viewer');
      const { commands, attempted } = everyMutation(staff, viewer, fixtures);
      const before = await scopedCounts(pool, fixtures, attempted);

      for (const command of commands) {
        await assert.rejects(
          command.run(),
          (error: KernelError) => error.code === 'not_allowed',
          command.name,
        );
      }

      // Refused before the module was reached: nothing the eight would have
      // written exists, and the tenancy they aimed at is still open.
      assert.deepEqual(await scopedCounts(pool, fixtures, attempted), before);
      assert.deepEqual(before.personIntent, 0);
      assert.deepEqual(before.buildingsOnStreet, 0);
    });
  });

  it('lets an operator and an admin through the same eight', async (t) => {
    await withPool(t, async (pool) => {
      const staff = world(pool);
      const admin = await sessionFor(pool, 'admin');

      for (const role of ['operator', 'admin'] as const) {
        const session = await sessionFor(pool, role);
        const fixtures = await buildWorld(staff, admin);
        for (const command of everyMutation(staff, session, fixtures)
          .commands) {
          assert.ok(await command.run(), `${role} / ${command.name}`);
        }
      }
    });
  });

  // "Every staff action writes an audit record with the actor and the role that
  // permitted it" — including the actions that were not permitted.
  it('audits the refusal with the actor and the role', async (t) => {
    await withPool(t, async (pool) => {
      const staff = world(pool);
      const viewer = await sessionFor(pool, 'viewer');

      await assert.rejects(
        staff.addBuilding(uniqueAddress(), viewer),
        (error: KernelError) => error.code === 'not_allowed',
      );

      const rows = await pool.query<{
        actor_kind: string;
        actor_role: string;
        outcome: string;
        error_code: string;
      }>(
        `SELECT actor_kind, actor_role, outcome, error_code
           FROM audit_log
          WHERE actor_id = $1 AND action = 'staff.addBuilding'`,
        [viewer.operator.id],
      );
      assert.equal(rows.rowCount, 1);
      assert.deepEqual(rows.rows[0], {
        actor_kind: 'staff',
        actor_role: 'viewer',
        outcome: 'error',
        error_code: 'not_allowed',
      });
    });
  });

  // Two rows for one successful mutation, deliberately: the edge records who
  // was allowed, the module records what changed. See SPEC-staff.md.
  it('audits a permitted mutation at the edge and in the module', async (t) => {
    await withPool(t, async (pool) => {
      const staff = world(pool);
      const operator = await sessionFor(pool, 'operator');
      const building = await staff.addBuilding(uniqueAddress(), operator);

      const rows = await pool.query<{ action: string; actor_role: string }>(
        `SELECT action, actor_role FROM audit_log
          WHERE actor_id = $1 AND outcome = 'ok'
          ORDER BY action`,
        [operator.operator.id],
      );
      assert.deepEqual(
        rows.rows.map((row) => row.action),
        ['portfolio.addBuilding', 'staff.addBuilding'],
      );
      // The module's row knows who; only the edge's row knows what permitted it.
      assert.deepEqual(
        rows.rows.map((row) => row.actor_role),
        [null, 'operator'],
      );
      assert.ok(building.id);
    });
  });
});
