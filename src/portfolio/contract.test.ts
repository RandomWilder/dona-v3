import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { fixedClock } from '../kernel/clock.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import {
  type Actor,
  type AddBuildingInput,
  createPortfolio,
} from './contract.ts';

// Contract tests: every command goes through contract.ts. The pool is used only
// to inspect what the commands left behind, never to shortcut one.
const actor: Actor = { kind: 'staff', id: 'contract-test' };

// The database persists between runs, so every test invents its own address.
function uniqueAddress(): AddBuildingInput {
  return {
    name: 'בית הרצל',
    city: 'תל אביב',
    street: `הרצל ${newId()}`,
    houseNumber: '12',
  };
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

describe('portfolio contract', () => {
  // The tree the slice asks for, read back whole.
  it('records building → unit → asset and reads the tree back', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });

      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3', floor: 1 },
        actor,
      );
      const asset = await portfolio.addAsset(
        {
          buildingId: building.id,
          unitId: unit.id,
          kind: 'boiler',
          label: 'דוד שמש',
        },
        actor,
      );

      const view = await portfolio.getUnit(unit.id);
      assert.equal(view.unit.id, unit.id);
      assert.equal(view.unit.label, '3');
      assert.equal(view.unit.floor, 1);
      assert.equal(view.building.id, building.id);
      assert.deepEqual(view.assets, [
        {
          id: asset.id,
          kind: 'boiler',
          label: 'דוד שמש',
          notes: null,
          scope: 'unit',
        },
      ]);
    });
  });

  // The slice's second half, stated as its own test.
  it('refuses a unit under a building that does not exist', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      await assert.rejects(
        portfolio.addUnit({ buildingId: newId(), label: '3' }, actor),
        (error: KernelError) => error.code === 'not_found',
      );
    });
  });

  it('treats one address written two ways as one building', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const address = uniqueAddress();

      const first = await portfolio.addBuilding(address, actor);
      const again = await portfolio.addBuilding(
        {
          ...address,
          city: `  ${address.city.toUpperCase()}  `,
          street: ` ${address.street} `,
          houseNumber: '12 ',
          name: 'a different name, ignored',
        },
        actor,
      );

      assert.deepEqual(again, first);
      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM portfolio_buildings WHERE street = $1',
        [address.street],
      );
      assert.equal(rows.rows[0]?.count, '1');
    });
  });

  it('treats a padded apartment number as the same unit', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const building = await portfolio.addBuilding(uniqueAddress(), actor);

      const first = await portfolio.addUnit(
        { buildingId: building.id, label: '3', floor: 1 },
        actor,
      );
      const again = await portfolio.addUnit(
        { buildingId: building.id, label: '03' },
        actor,
      );

      assert.deepEqual(again, first);
      // Two buildings may each have an apartment 3 — the key is scoped.
      const other = await portfolio.addBuilding(uniqueAddress(), actor);
      const elsewhere = await portfolio.addUnit(
        { buildingId: other.id, label: '3' },
        actor,
      );
      assert.notEqual(elsewhere.id, first.id);
    });
  });

  it("puts a lift in scope for a unit without making it the unit's", async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );

      const lift = await portfolio.addAsset(
        { buildingId: building.id, kind: 'lift' },
        actor,
      );
      const boiler = await portfolio.addAsset(
        { buildingId: building.id, unitId: unit.id, kind: 'boiler' },
        actor,
      );
      assert.equal(lift.unitId, null);

      const view = await portfolio.getUnit(unit.id);
      const byId = new Map(view.assets.map((a) => [a.id, a.scope]));
      assert.equal(byId.get(boiler.id), 'unit');
      assert.equal(byId.get(lift.id), 'building');
      assert.equal(view.assets.length, 2);

      // Recording the same building asset twice is one lift, not two.
      const again = await portfolio.addAsset(
        { buildingId: building.id, kind: 'lift' },
        actor,
      );
      assert.deepEqual(again, lift);
    });
  });

  it('refuses an asset naming a unit from another building', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const one = await portfolio.addBuilding(uniqueAddress(), actor);
      const two = await portfolio.addBuilding(uniqueAddress(), actor);
      const unit = await portfolio.addUnit(
        { buildingId: one.id, label: '3' },
        actor,
      );

      await assert.rejects(
        portfolio.addAsset(
          { buildingId: two.id, unitId: unit.id, kind: 'boiler' },
          actor,
        ),
        (error: KernelError) => error.code === 'invalid',
      );
      await assert.rejects(
        portfolio.addAsset(
          { buildingId: one.id, unitId: newId(), kind: 'boiler' },
          actor,
        ),
        (error: KernelError) => error.code === 'not_found',
      );
    });
  });

  it('reports an unknown unit id as not_found, not null', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      await assert.rejects(
        portfolio.getUnit(newId()),
        (error: KernelError) => error.code === 'not_found',
      );
    });
  });

  // Access notes are entry codes: a caller has to ask, not remember to strip.
  it('withholds access notes unless the read asks for them', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
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

      const created = JSON.stringify([building, unit]);
      assert.equal(created.includes('4471'), false);
      assert.equal(created.includes('מפתח'), false);

      const closed = await portfolio.getUnit(unit.id);
      assert.equal(closed.unit.accessNotes, undefined);
      assert.equal(closed.building.accessNotes, undefined);
      assert.equal(JSON.stringify(closed).includes('4471'), false);

      const asked = await portfolio.getUnit(unit.id, {
        includeAccessNotes: true,
      });
      assert.equal(asked.unit.accessNotes, 'מפתח אצל השכן');
      assert.equal(asked.building.accessNotes, 'קוד כניסה 4471');
    });
  });

  it('audits every mutation and every refusal', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const address = uniqueAddress();
      const building = await portfolio.addBuilding(address, actor);
      const unit = await portfolio.addUnit(
        { buildingId: building.id, label: '3' },
        actor,
      );
      await portfolio.addAsset(
        { buildingId: building.id, unitId: unit.id, kind: 'boiler' },
        actor,
      );
      await assert.rejects(
        portfolio.addUnit({ buildingId: building.id, label: '' }, actor),
      );

      const onBuilding = await pool.query<{
        action: string;
        outcome: string;
        error_code: string | null;
      }>(
        `SELECT action, outcome, error_code FROM audit_log
          WHERE subject_id = $1 ORDER BY at`,
        [building.id],
      );
      assert.deepEqual(onBuilding.rows, [
        { action: 'portfolio.addUnit', outcome: 'ok', error_code: null },
        { action: 'portfolio.addAsset', outcome: 'ok', error_code: null },
        {
          action: 'portfolio.addUnit',
          outcome: 'error',
          error_code: 'invalid',
        },
      ]);

      // A building has no subject id — its address is what identifies it.
      const onAddress = await pool.query<{ actor_kind: string }>(
        `SELECT actor_kind FROM audit_log
          WHERE action = 'portfolio.addBuilding' AND inputs->>'street' = $1`,
        [address.street],
      );
      assert.deepEqual(onAddress.rows, [{ actor_kind: 'staff' }]);
    });
  });

  it('writes created_at from the injected clock', async (t) => {
    await withPool(t, async (pool) => {
      const at = new Date('2026-08-23T09:00:00.000Z');
      const portfolio = createPortfolio({ pool, clock: fixedClock(at) });
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const row = await pool.query<{ created_at: Date }>(
        'SELECT created_at FROM portfolio_buildings WHERE id = $1',
        [building.id],
      );
      assert.equal(row.rows[0]?.created_at.toISOString(), at.toISOString());
    });
  });

  it('rejects what a caller can get wrong, at the edge', async (t) => {
    await withPool(t, async (pool) => {
      const portfolio = createPortfolio({ pool });
      const building = await portfolio.addBuilding(uniqueAddress(), actor);
      const invalid = (error: KernelError) => error.code === 'invalid';

      await assert.rejects(
        portfolio.addBuilding({ ...uniqueAddress(), name: '  ' }, actor),
        invalid,
      );
      await assert.rejects(
        portfolio.addBuilding({ ...uniqueAddress(), city: '' }, actor),
        invalid,
      );
      await assert.rejects(
        portfolio.addUnit({ buildingId: 'not-an-id', label: '3' }, actor),
        invalid,
      );
      await assert.rejects(
        portfolio.addUnit(
          { buildingId: building.id, label: '3', floor: 1.5 },
          actor,
        ),
        invalid,
      );
      await assert.rejects(
        portfolio.addAsset(
          {
            buildingId: building.id,
            kind: 'chandelier' as 'boiler',
          },
          actor,
        ),
        invalid,
      );
      await assert.rejects(portfolio.getUnit('not-an-id'), invalid);
    });
  });
});
