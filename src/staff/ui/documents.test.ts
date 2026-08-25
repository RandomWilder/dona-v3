import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../../app.ts';
import { createIdentity } from '../../identity/contract.ts';
import { newId } from '../../kernel/ids.ts';
import { createMemoryStore } from '../../kernel/objects.ts';
import { migratedPoolOrNull, skipReason } from '../../kernel/pg-support.ts';
import { type Actor, createOccupancy } from '../../occupancy/contract.ts';
import { createPortfolio } from '../../portfolio/contract.ts';
import { createStaffAuth } from '../internal/auth.ts';
import type { StaffRole } from '../internal/roles.ts';

// Slice 11.2, end to end through the HTTP edge: the upload form, the guard on
// it, and the bytes coming back down.
const actor: Actor = { kind: 'staff', id: 'documents-test' };
const password = 'correct-horse-battery';
const boundary = 'dona-test-boundary';

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

async function loginAs(
  pool: Pool,
  app: ReturnType<typeof buildApp>,
  role: StaffRole,
): Promise<string> {
  const email = `docs-${newId()}@dona.test`;
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

// One occupied flat and one empty one, in the same building.
async function seedPlace(pool: Pool) {
  const identity = createIdentity({ pool });
  const portfolio = createPortfolio({ pool });
  const occupancy = createOccupancy({ pool, identity, portfolio });

  const building = await portfolio.addBuilding(
    {
      name: 'בית הרצל',
      city: 'תל אביב',
      street: `הרצל ${newId()}`,
      houseNumber: '12',
    },
    actor,
  );
  const unit = await portfolio.addUnit(
    { buildingId: building.id, label: '3', floor: 1 },
    actor,
  );
  const vacant = await portfolio.addUnit(
    { buildingId: building.id, label: '4', floor: 1 },
    actor,
  );
  const tenancy = await occupancy.openTenancy(
    { unitId: unit.id, startsOn: '2020-01-01' },
    actor,
  );
  return { building, unit, vacant, tenancy };
}

// A browser's multipart body, by hand: the point of the slice is that the form
// is a plain HTML form, so the test posts what one posts.
function multipartUpload(
  bytes: Buffer,
  options: { kind?: string; filename?: string } = {},
): string {
  const filename = options.filename ?? 'lease.pdf';
  const parts = [
    `--${boundary}`,
    'content-disposition: form-data; name="kind"',
    '',
    options.kind ?? 'lease',
    `--${boundary}`,
    `content-disposition: form-data; name="file"; filename="${filename}"`,
    'content-type: application/pdf',
    '',
    bytes.toString('binary'),
    `--${boundary}--`,
    '',
  ];
  return parts.join('\r\n');
}

const pdf = () => Buffer.from('%PDF-1.7\nthe signed lease\n%%EOF');

describe('lease documents at the edge', () => {
  it('uploads from the unit page and serves the same bytes back', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '11.2-test',
        store: createMemoryStore(),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);

      const uploaded = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents`,
        headers: {
          cookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartUpload(pdf()),
      });
      // Back to the page it came from, so a reload does not re-submit.
      assert.equal(uploaded.statusCode, 302);
      assert.equal(uploaded.headers.location, `/admin/units/${place.unit.id}`);

      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}`,
        headers: { cookie },
      });
      assert.equal(page.statusCode, 200);
      assert.ok(page.body.includes('חוזה שכירות'));

      const row = await pool.query<{ id: string; object_path: string }>(
        'SELECT id, object_path FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const document = row.rows[0];
      assert.ok(document);
      // The filename the browser sent is discarded, not stored: it is a
      // person's name on its way into a log.
      assert.ok(!document.object_path.includes('lease.pdf'));
      assert.ok(document.object_path.includes(`unit-${place.unit.id}`));
      assert.ok(page.body.includes(`/admin/documents/${document.id}`));

      const served = await app.inject({
        method: 'GET',
        url: `/admin/documents/${document.id}`,
        headers: { cookie },
      });
      assert.equal(served.statusCode, 200);
      assert.equal(served.headers['content-type'], 'application/pdf');
      assert.equal(served.headers['cache-control'], 'no-store');
      assert.equal(served.rawPayload.toString(), pdf().toString());
    });
  });

  it('refuses a viewer, and leaves the refusal in the audit log', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '11.2-test',
        store: createMemoryStore(),
      });
      const cookie = await loginAs(pool, app, 'viewer');
      const place = await seedPlace(pool);

      const refused = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents`,
        headers: {
          cookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartUpload(pdf()),
      });
      assert.equal(refused.statusCode, 302);
      assert.match(refused.headers.location as string, /error=not_allowed/);

      // Nothing was written, and the attempt is on the record.
      const rows = await pool.query(
        'SELECT count(*)::int AS n FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      assert.equal(rows.rows[0].n, 0);
      const audited = await pool.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'staff.attachDocument' AND outcome = 'error'
            AND error_code = 'not_allowed'`,
      );
      assert.ok(audited.rows[0].n > 0);

      // And the form is not offered to them either — manners, after the gate.
      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}`,
        headers: { cookie },
      });
      assert.ok(!page.body.includes('enctype="multipart/form-data"'));
      assert.ok(page.body.includes('מסמכים'));
    });
  });

  it('refuses a flat with no current tenancy rather than inventing one', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '11.2-test',
        store: createMemoryStore(),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);

      const refused = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.vacant.id}/documents`,
        headers: {
          cookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartUpload(pdf()),
      });
      assert.equal(refused.statusCode, 302);
      assert.match(refused.headers.location as string, /error=invalid/);

      // A vacancy shows no upload form at all, for an admin either.
      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.vacant.id}`,
        headers: { cookie },
      });
      assert.ok(page.body.includes('הדירה פנויה'));
      assert.ok(!page.body.includes('enctype="multipart/form-data"'));
    });
  });

  it('sends a logged-out browser to the login page, both ways', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '11.2-test',
        store: createMemoryStore(),
      });
      const place = await seedPlace(pool);

      const posted = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents`,
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartUpload(pdf()),
      });
      assert.equal(posted.headers.location, '/admin/login');

      const read = await app.inject({
        method: 'GET',
        url: `/admin/documents/${newId()}`,
      });
      assert.equal(read.headers.location, '/admin/login');
    });
  });
});
