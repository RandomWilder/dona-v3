import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../../app.ts';
import { createIdentity } from '../../identity/contract.ts';
import { newId } from '../../kernel/ids.ts';
import { createMemoryStore } from '../../kernel/objects.ts';
import { embeddingColumnDimensions } from '../../kernel/config.ts';
import { createFakeEmbedder } from '../../kernel/embeddings.ts';
import { samplePdf } from '../../kernel/pdf-sample.ts';
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
        embedder: createFakeEmbedder(embeddingColumnDimensions),
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
        embedder: createFakeEmbedder(embeddingColumnDimensions),
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
        embedder: createFakeEmbedder(embeddingColumnDimensions),
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
        embedder: createFakeEmbedder(embeddingColumnDimensions),
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

// Slice 12.1 at the same edge: the button that reads a stored lease into
// clauses, and the page that shows what came out. The reader here is the real
// one -- `samplePdf` writes a PDF that pdfjs opens -- so this is the only test
// that runs upload, extraction, chunking and the screen in one pass.
describe('lease chunks at the edge', () => {
  const filler =
    'The parties confirm they have read this agreement and understood it.';

  const lease = () =>
    samplePdf([
      [
        { x: 120, y: 760, text: '1. The flat is let unfurnished.' },
        // Enough text for the page to be a page: below `minPageChars` of
        // readable text the chunker reads a page as an image with a footer.
        { x: 120, y: 730, text: filler },
        // The two-column annex row, mirrored: this fixture is Latin and so
        // reads left to right, which puts the label on the left where the
        // Hebrew document puts it on the right. Same row, same pairing.
        { x: 120, y: 700, text: 'Term' },
        { x: 380, y: 700, text: '24 months' },
      ],
      [
        { x: 120, y: 760, text: '2. Rent is payable monthly in advance.' },
        { x: 120, y: 730, text: filler },
      ],
      // A page with no runs: content, carrying no text layer -- what a scan or
      // a floor plan looks like to the reader.
      [],
    ]);

  async function uploaded(
    app: ReturnType<typeof buildApp>,
    cookie: string,
    unitId: string,
  ): Promise<void> {
    await app.inject({
      method: 'POST',
      url: `/admin/units/${unitId}/documents`,
      headers: {
        cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartUpload(lease()),
    });
  }

  it('reads a stored lease into clauses and shows them', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '12.1-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);
      await uploaded(app, cookie, place.unit.id);

      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;

      // Before the button is pressed, the unit page says so -- "not read yet"
      // and "read, and produced nothing" are different facts.
      const before = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}`,
        headers: { cookie },
      });
      assert.ok(before.body.includes('טרם נקרא'));

      const ingested = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/ingest`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      assert.equal(ingested.statusCode, 302);
      assert.equal(ingested.headers.location, `/admin/units/${place.unit.id}`);

      const chunks = await pool.query<{
        clause_ref: string | null;
        page_from: number;
        tenancy_id: string;
      }>(
        `SELECT clause_ref, page_from, tenancy_id FROM occupancy_document_chunks
          WHERE document_id = $1 ORDER BY ordinal`,
        [documentId],
      );
      assert.deepEqual(
        chunks.rows.map((chunk) => chunk.clause_ref),
        ['§1', '§2'],
      );
      // The isolation column, carried down from the document row.
      for (const chunk of chunks.rows) {
        assert.equal(chunk.tenancy_id, place.tenancy.id);
      }
      assert.equal(chunks.rows[1]?.page_from, 2);

      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/chunks`,
        headers: { cookie },
      });
      assert.equal(page.statusCode, 200);
      // The reading state survives the redirect that discarded it in this
      // slice's first cut: the screen reads it off the document row.
      assert.ok(page.body.includes('ללא שכבת טקסט'));
      assert.ok(page.body.includes('3'));
      assert.ok(page.body.includes('§1'));
      assert.ok(page.body.includes('unfurnished'));
      // The two-column row is bound to its label on the way through, which is
      // the failure the whole slice is shaped around.
      assert.ok(page.body.includes('Term: 24 months'));

      // And the unit page now counts them.
      const after = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}`,
        headers: { cookie },
      });
      assert.ok(after.body.includes('סעיפים'));
      assert.ok(!after.body.includes('טרם נקרא'));
    });
  });

  it('refuses a viewer the button, and leaves the refusal on the record', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '12.1-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      const admin = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);
      await uploaded(app, admin, place.unit.id);
      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;

      const viewer = await loginAs(pool, app, 'viewer');
      const refused = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/ingest`,
        headers: {
          cookie: viewer,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      assert.equal(refused.statusCode, 302);
      assert.match(refused.headers.location as string, /error=not_allowed/);

      const written = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM occupancy_document_chunks WHERE document_id = $1',
        [documentId],
      );
      assert.equal(written.rows[0]?.n, 0);
      const audited = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'staff.ingestDocument' AND outcome = 'error'
            AND error_code = 'not_allowed'`,
      );
      assert.ok((audited.rows[0]?.n ?? 0) > 0);

      // A viewer may still read what an operator produced -- the button is the
      // write, and this page is a read -- but it is offered no button.
      const page = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}`,
        headers: { cookie: viewer },
      });
      assert.ok(!page.body.includes('/ingest'));
    });
  });

  it('refuses a document that is not this unit’s, through either route', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '12.1-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const mine = await seedPlace(pool);
      const theirs = await seedPlace(pool);
      await uploaded(app, cookie, theirs.unit.id);
      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [theirs.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;

      // A pair of ids in a URL is a caller-supplied claim. 11.2 resolves the
      // tenancy from the unit rather than trusting the browser; this is the
      // same rule where the browser supplies both.
      const posted = await app.inject({
        method: 'POST',
        url: `/admin/units/${mine.unit.id}/documents/${documentId}/ingest`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      assert.match(posted.headers.location as string, /error=not_found/);

      const read = await app.inject({
        method: 'GET',
        url: `/admin/units/${mine.unit.id}/documents/${documentId}/chunks`,
        headers: { cookie },
      });
      assert.equal(read.statusCode, 404);

      const written = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM occupancy_document_chunks WHERE document_id = $1',
        [documentId],
      );
      assert.equal(written.rows[0]?.n, 0);
    });
  });

  it('sends a logged-out browser to the login page', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '12.1-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      const place = await seedPlace(pool);
      const read = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.unit.id}/documents/${newId()}/chunks`,
      });
      assert.equal(read.headers.location, '/admin/login');
    });
  });
  it('searches this tenancy’s clauses, and cannot be pointed at another’s', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '12.2-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);
      await uploaded(app, cookie, place.unit.id);

      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;
      const base = `/admin/units/${place.unit.id}/documents/${documentId}/chunks`;

      await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/ingest`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });

      // No question asked: the field is there, and no results are claimed.
      const empty = await app.inject({
        method: 'GET',
        url: base,
        headers: { cookie },
      });
      assert.equal(empty.statusCode, 200);
      assert.ok(empty.body.includes('חיפוש בסעיפי החוזה'));
      assert.ok(!empty.body.includes('לא נמצאו סעיפים'));

      const found = await app.inject({
        method: 'GET',
        url: `${base}?q=${encodeURIComponent('Rent is payable monthly in advance.')}`,
        headers: { cookie },
      });
      assert.equal(found.statusCode, 200);
      assert.ok(found.body.includes('Rent is payable monthly'));

      // The tenancy the search filters on is resolved from the unit on the
      // server, so a URL that pairs this document with a *different* unit is a
      // caller-supplied claim and is refused -- rather than quietly searching
      // one tenancy while displaying another's heading.
      const crossed = await app.inject({
        method: 'GET',
        url: `/admin/units/${place.vacant.id}/documents/${documentId}/chunks?q=rent`,
        headers: { cookie },
      });
      assert.equal(crossed.statusCode, 404);
    });
  });
});
