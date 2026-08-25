import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../../app.ts';
import { createIdentity } from '../../identity/contract.ts';
import { newId } from '../../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import { createOccupancy } from '../../occupancy/contract.ts';
import { createPortfolio } from '../../portfolio/contract.ts';
import { createStaffAuth } from '../internal/auth.ts';
import type { StaffRole } from '../internal/roles.ts';

// Slice 10.1's acceptance bar, driven through HTTP with a real logged-in
// session: the pilot building is browsable, and a viewer who posts is refused
// by the server rather than by a missing button.

const password = 'correct-horse-battery';
const actor = { kind: 'staff' as const, id: 'browse-test' };

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

// The cookie a browser would carry, obtained the way a browser obtains it.
async function loginAs(
  pool: Pool,
  app: ReturnType<typeof buildApp>,
  role: StaffRole,
): Promise<string> {
  const email = `browse-${newId()}@dona.test`;
  await createStaffAuth(pool).createOperator({ email, password, role });
  const admitted = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password }).toString(),
  });
  const raw = admitted.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : (raw ?? '')).split(';')[0];
}

// One building, one flat, one tenant and one guarantor — the shape the real
// pilot import lands in.
async function seedBuilding(pool: Pool, displayName: string) {
  const identity = createIdentity({ pool });
  const portfolio = createPortfolio({ pool });
  const occupancy = createOccupancy({ pool, identity, portfolio });

  const street = `הרצל ${newId()}`;
  const building = await portfolio.addBuilding(
    { name: 'בית הרצל', city: 'תל אביב', street, houseNumber: '12' },
    actor,
  );
  const unit = await portfolio.addUnit(
    { buildingId: building.id, label: '3', floor: 1 },
    actor,
  );
  const person = await identity.addPerson(
    { intentKey: newId(), displayName, kinds: ['tenant'] },
    actor,
  );
  const phone = `05${Math.floor(Math.random() * 1e8)
    .toString()
    .padStart(8, '0')}`;
  await identity.addPhone({ personId: person.id, phone }, actor);
  const tenancy = await occupancy.openTenancy(
    { unitId: unit.id, startsOn: '2020-01-01' },
    actor,
  );
  await occupancy.addParty(
    { tenancyId: tenancy.id, personId: person.id, role: 'tenant' },
    actor,
  );
  return { building, unit, person, phone, street };
}

describe('admin browse', () => {
  it('walks building → unit → person as an admin', async (t) => {
    // *Done when:* the pilot building is browsable — buildings, units, and the
    // people in them. Each step uses only a link the previous page rendered.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'admin');
      const seeded = await seedBuilding(pool, 'דנה כהן');
      const get = (url: string) =>
        app.inject({ method: 'GET', url, headers: { cookie } });

      const list = await get('/admin/properties');
      assert.equal(list.statusCode, 200);
      assert.ok(list.body.includes(seeded.street));
      const buildingHref = `/admin/properties/${seeded.building.id}`;
      assert.ok(list.body.includes(buildingHref), 'links to the building');
      // The nav marks where you are, server-side.
      assert.ok(
        list.body.includes('data-dest="properties" aria-current="page"'),
      );

      const building = await get(buildingHref);
      assert.equal(building.statusCode, 200);
      const unitHref = `/admin/units/${seeded.unit.id}`;
      assert.ok(building.body.includes(unitHref), 'links to the unit');

      const unit = await get(unitHref);
      assert.equal(unit.statusCode, 200);
      assert.ok(unit.body.includes('דנה כהן'), 'the person is on the page');
      const personHref = `/admin/people/${seeded.person.id}`;
      assert.ok(unit.body.includes(personHref), 'links to the person');

      const person = await get(personHref);
      assert.equal(person.statusCode, 200);
      assert.ok(person.body.includes('דנה כהן'));
      assert.ok(person.body.includes(seeded.phone.replace('0', '+972')));
    });
  });

  it('finds a person by any spelling of their number', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'viewer');
      const seeded = await seedBuilding(pool, 'יוסי לוי');
      const local = seeded.phone;
      const spellings = [
        local,
        `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`,
        `+972${local.slice(1)}`,
      ];
      for (const spelling of spellings) {
        const found = await app.inject({
          method: 'GET',
          url: `/admin/people?phone=${encodeURIComponent(spelling)}`,
          headers: { cookie },
        });
        assert.equal(found.statusCode, 200);
        assert.ok(found.body.includes('יוסי לוי'), spelling);
      }
    });
  });

  it('answers a nonsense number the same way as an unknown one', async (t) => {
    // Probing the box must not teach which numbers are in the system: an
    // invalid number and one nobody holds get the same page.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'viewer');
      for (const phone of ['not-a-phone', '0500000000']) {
        const answer = await app.inject({
          method: 'GET',
          url: `/admin/people?phone=${encodeURIComponent(phone)}`,
          headers: { cookie },
        });
        assert.equal(answer.statusCode, 200);
        assert.ok(answer.body.includes('לא נמצא אדם עם המספר'), phone);
      }
    });
  });

  it('lets a viewer read every page and refuses every create', async (t) => {
    // The bar, proven by posting rather than by looking for a button.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'viewer');
      const seeded = await seedBuilding(pool, 'דנה כהן');
      const form = (url: string, fields: Record<string, string>) =>
        app.inject({
          method: 'POST',
          url,
          headers: {
            cookie,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: new URLSearchParams(fields).toString(),
        });

      // Reading is allowed — a viewer holds `read`.
      for (const url of [
        '/admin/properties',
        `/admin/properties/${seeded.building.id}`,
        `/admin/units/${seeded.unit.id}`,
        '/admin/people',
        `/admin/people/${seeded.person.id}`,
      ]) {
        const page = await app.inject({
          method: 'GET',
          url,
          headers: { cookie },
        });
        assert.equal(page.statusCode, 200, url);
      }

      const street = `הרצל ${newId()}`;
      const attempts: Array<[string, Record<string, string>]> = [
        [
          '/admin/properties',
          { name: 'בית', city: 'תל אביב', street, houseNumber: '9' },
        ],
        [
          `/admin/properties/${seeded.building.id}/units`,
          { label: `viewer-${newId()}` },
        ],
        ['/admin/people', { displayName: 'מישהו', phone: '' }],
      ];
      for (const [url, fields] of attempts) {
        const refused = await form(url, fields);
        assert.equal(refused.statusCode, 302, url);
        assert.match(
          refused.headers.location as string,
          /error=not_allowed/,
          url,
        );
      }

      // And nothing moved: the ids the attempts aimed at are re-counted.
      const built = await pool.query(
        'SELECT count(*)::int AS n FROM portfolio_buildings WHERE street = $1',
        [street],
      );
      assert.equal(built.rows[0].n, 0);
      const units = await pool.query(
        'SELECT count(*)::int AS n FROM portfolio_units WHERE building_id = $1',
        [seeded.building.id],
      );
      assert.equal(units.rows[0].n, 1, 'still only the seeded unit');
    });
  });

  it('lets an operator create through the same forms', async (t) => {
    // The refusal above is about the role, not about the inputs.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'operator');
      const street = `הרצל ${newId()}`;
      const created = await app.inject({
        method: 'POST',
        url: '/admin/properties',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({
          name: 'בית חדש',
          city: 'חיפה',
          street,
          houseNumber: '4',
        }).toString(),
      });
      assert.equal(created.statusCode, 302);
      assert.equal(created.headers.location, '/admin/properties');

      // Read back through the page, not through the pool: the row is only
      // created if the browse path can see it.
      const list = await app.inject({
        method: 'GET',
        url: '/admin/properties',
        headers: { cookie },
      });
      assert.ok(list.body.includes(street));
    });
  });

  it('renders a name that looks like a script tag inert, end to end', async (t) => {
    // The escaping bar, proven through the database rather than in the view
    // unit: the name goes in through a real command and comes back on a page.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'admin');
      const seeded = await seedBuilding(pool, '<script>alert(1)</script>');
      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${seeded.unit.id}`,
        headers: { cookie },
      });
      assert.equal(page.statusCode, 200);
      assert.ok(!page.body.includes('<script>alert(1)</script>'));
      assert.ok(page.body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
  });

  it('audits a detail read and leaves a list read untraced', async (t) => {
    // The rule taken with Asaf and written into SPEC-staff.md: who opened a
    // tenant's record is a real question; who clicked a nav item is not.
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const cookie = await loginAs(pool, app, 'admin');
      const seeded = await seedBuilding(pool, 'דנה כהן');
      const countFor = async (subject: string) => {
        const found = await pool.query(
          'SELECT count(*)::int AS n FROM audit_log WHERE subject_id = $1',
          [subject],
        );
        return found.rows[0].n as number;
      };

      const before = await countFor(seeded.unit.id);
      await app.inject({
        method: 'GET',
        url: '/admin/properties',
        headers: { cookie },
      });
      await app.inject({
        method: 'GET',
        url: `/admin/properties/${seeded.building.id}`,
        headers: { cookie },
      });
      assert.equal(
        await countFor(seeded.unit.id),
        before,
        'a list read writes nothing',
      );

      await app.inject({
        method: 'GET',
        url: `/admin/units/${seeded.unit.id}`,
        headers: { cookie },
      });
      const row = await pool.query(
        `SELECT action, actor_kind, actor_role, outcome
           FROM audit_log
          WHERE subject_id = $1 AND action = 'staff.getUnitDetail'
          ORDER BY at DESC LIMIT 1`,
        [seeded.unit.id],
      );
      assert.equal(row.rowCount, 1, 'a detail read is on the record');
      assert.equal(row.rows[0].actor_kind, 'staff');
      assert.equal(row.rows[0].actor_role, 'admin');
      assert.equal(row.rows[0].outcome, 'ok');

      // And the name that was on the screen is not in the trail: the log says
      // who looked at what, never a second copy of the data.
      const inputs = await pool.query(
        `SELECT inputs::text AS text FROM audit_log
          WHERE subject_id = $1 AND action = 'staff.getUnitDetail'
          ORDER BY at DESC LIMIT 1`,
        [seeded.unit.id],
      );
      assert.ok(!inputs.rows[0].text.includes('דנה'));
    });
  });

  it('sends a logged-out browser to the login page from every view', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({ pool, version: '10.1-test' });
      const seeded = await seedBuilding(pool, 'דנה כהן');
      for (const url of [
        '/admin/properties',
        `/admin/properties/${seeded.building.id}`,
        `/admin/units/${seeded.unit.id}`,
        '/admin/people',
        `/admin/people/${seeded.person.id}`,
        '/admin/conversations',
      ]) {
        const closed = await app.inject({ method: 'GET', url });
        assert.equal(closed.statusCode, 302, url);
        assert.equal(closed.headers.location, '/admin/login', url);
      }
    });
  });
});
