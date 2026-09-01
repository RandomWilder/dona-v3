import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { buildApp } from '../../app.ts';
import { createIdentity } from '../../identity/contract.ts';
import { embeddingColumnDimensions } from '../../kernel/config.ts';
import { createFakeEmbedder } from '../../kernel/embeddings.ts';
import { createFakeExtractor } from '../../kernel/extraction.ts';
import { newId } from '../../kernel/ids.ts';
import { createMemoryStore } from '../../kernel/objects.ts';
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
      assert.ok(empty.body.includes('שאלה על הדירה'));
      assert.ok(!empty.body.includes('אין לכך מענה'));

      const found = await app.inject({
        method: 'GET',
        url: `${base}?q=${encodeURIComponent('Rent is payable monthly in advance.')}`,
        headers: { cookie },
      });
      assert.equal(found.statusCode, 200);
      assert.ok(found.body.includes('Rent is payable monthly'));
      // Slice 14.1b: the page says *where* the answer was allowed to come from.
      assert.ok(found.body.includes('החוזה של הדירה הזו'));

      // And the third outcome, at the edge rather than only in the unit tests:
      // a question neither this lease nor the company's guidance speaks to is
      // refused, and the screen says so rather than showing an empty list.
      //
      // Worded to share no word with this fixture, which is harder in English
      // than it looks: the rule's stopword list is Hebrew, so `the` counts as a
      // content term here and matches every page of a Latin document. Nothing
      // in production is English, and tuning the rule to a test fixture is the
      // thing not to do.
      const refused = await app.inject({
        method: 'GET',
        url: `${base}?q=${encodeURIComponent('Which orchestra performed yesterday evening?')}`,
        headers: { cookie },
      });
      assert.equal(refused.statusCode, 200);
      assert.ok(refused.body.includes('אין לכך מענה בחוזה או בנהלים'));

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

  // Slice 13.1 at the edge. What is asserted here is the route: the guard, the
  // server-side pairing of unit and document, and where the browser lands. What
  // the model is *sent* and what is believed of its reply is pinned in
  // internal/twin.test.ts, whose fixtures are Hebrew -- this file's sample PDF
  // is Latin, and clause selection is Hebrew domain vocabulary.
  it('reads the twin from the chunks page, and refuses a viewer', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '13.1-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
        extractor: createFakeExtractor(() => ({ found: false })),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);
      await uploaded(app, cookie, place.unit.id);

      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;
      const chunks = `/admin/units/${place.unit.id}/documents/${documentId}/chunks`;
      const extract = `/admin/units/${place.unit.id}/documents/${documentId}/extract`;
      const form = {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      };

      await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/ingest`,
        headers: form,
        payload: '',
      });

      const read = await app.inject({
        method: 'POST',
        url: extract,
        headers: form,
        payload: '',
      });
      // Back to the page where the fields and the clauses they cite are read
      // against each other, rather than to the unit page the ingest returns to.
      assert.equal(read.statusCode, 302);
      assert.equal(read.headers.location, chunks);

      const page = await app.inject({
        method: 'GET',
        url: chunks,
        headers: { cookie },
      });
      assert.equal(page.statusCode, 200);
      assert.ok(page.body.includes('שדות החוזה'));
      // A field nothing was read for is absent, not blank.
      assert.ok(page.body.includes('לא נקרא מהחוזה'));

      // The same guard the ingest is behind: reading a lease into fields writes
      // rows, so a viewer is refused and the refusal is on the record.
      const viewer = await loginAs(pool, app, 'viewer');
      const refused = await app.inject({
        method: 'POST',
        url: extract,
        headers: {
          cookie: viewer,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      assert.equal(refused.statusCode, 302);
      assert.match(String(refused.headers.location), /error=not_allowed/);
      // Counted, not compared to one: this database persists between runs, so
      // the assertion is that the refusal was recorded rather than that it is
      // the only one ever recorded.
      const refusals = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'staff.extractTwin' AND outcome = 'error'
            AND error_code = 'not_allowed'`,
      );
      assert.ok((refusals.rows[0]?.n ?? 0) > 0);
      const viewerPage = await app.inject({
        method: 'GET',
        url: chunks,
        headers: { cookie: viewer },
      });
      assert.ok(!viewerPage.body.includes('/extract'));

      // A pair of ids in a URL is a caller-supplied claim until the server
      // checks it belongs together -- the rule the ingest and the search
      // already answer to.
      const crossed = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.vacant.id}/documents/${documentId}/extract`,
        headers: form,
        payload: '',
      });
      assert.equal(crossed.statusCode, 302);
      assert.match(String(crossed.headers.location), /error=not_found/);
    });
  });

  // Slice 13.2 at the edge: the two decisions, the guard on them, and the form
  // parsing that turns a page of inputs into edits and drops.
  //
  // The fact this reviews is *placed* rather than extracted, and that is a
  // property of the fixture rather than a shortcut. `samplePdf` writes Latin
  // text on purpose (pdf-sample.ts: Hebrew would need an embedded font and a
  // CMap), and which clauses a field is read from is Hebrew domain vocabulary --
  // so no extraction this file can run produces a field to review. What the
  // command does with a review is pinned in occupancy's contract tests; what is
  // asserted here is the route.
  it('confirms and corrects a field from the chunks page, and refuses a viewer', async (t) => {
    await withPool(t, async (pool) => {
      const app = buildApp({
        pool,
        version: '13.2-test',
        store: createMemoryStore(),
        embedder: createFakeEmbedder(embeddingColumnDimensions),
        extractor: createFakeExtractor(() => ({ found: false })),
      });
      const cookie = await loginAs(pool, app, 'admin');
      const place = await seedPlace(pool);
      await uploaded(app, cookie, place.unit.id);

      const row = await pool.query<{ id: string }>(
        'SELECT id FROM occupancy_documents WHERE tenancy_id = $1',
        [place.tenancy.id],
      );
      const documentId = row.rows[0]?.id as string;
      const chunks = `/admin/units/${place.unit.id}/documents/${documentId}/chunks`;
      const form = {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      };

      await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/ingest`,
        headers: form,
        payload: '',
      });

      const clause = await pool.query<{ id: string; clause_ref: string }>(
        `SELECT id, clause_ref FROM occupancy_document_chunks
          WHERE document_id = $1 ORDER BY ordinal LIMIT 1`,
        [documentId],
      );
      const chunkId = clause.rows[0]?.id as string;
      const factId = newId();
      await pool.query(
        `INSERT INTO occupancy_lease_facts
           (id, document_id, tenancy_id, field, value, chunk_id, clause_ref,
            page_from, page_to, confidence, model, extracted_at)
         VALUES ($1, $2, $3, 'securities', $4, $5, $6, 1, 1, 'high', 'test',
                 now())`,
        [
          factId,
          documentId,
          place.tenancy.id,
          JSON.stringify({
            items: [
              {
                kind: 'deposit',
                statedAmount: '10,000',
                statedText: 'cash deposit',
                chunkId,
                clauseRef: clause.rows[0]?.clause_ref ?? null,
              },
              {
                kind: 'bank guarantee',
                statedAmount: '10,000',
                statedText: 'autonomous guarantee',
                chunkId,
                clauseRef: clause.rows[0]?.clause_ref ?? null,
              },
            ],
          }),
          chunkId,
          clause.rows[0]?.clause_ref ?? null,
        ],
      );

      const fields = `/admin/units/${place.unit.id}/documents/${documentId}/fields/securities`;

      // The page offers both decisions, and carries the extraction they are
      // statements about.
      const before = await app.inject({
        method: 'GET',
        url: chunks,
        headers: { cookie },
      });
      assert.ok(before.body.includes(`${fields}/confirm`));
      assert.ok(before.body.includes(`name="factId" value="${factId}"`));
      assert.ok(before.body.includes('name="drop.items.1"'));

      // The correction: one row removed, one value retyped. The form posts
      // changes, never a value.
      const corrected = await app.inject({
        method: 'POST',
        url: `${fields}/correct`,
        headers: form,
        payload: new URLSearchParams({
          factId,
          'drop.items.1': '1',
          'edit.items.0.statedAmount': '12,000',
        }).toString(),
      });
      assert.equal(corrected.statusCode, 302);
      assert.equal(corrected.headers.location, chunks);

      const stored = await pool.query<{
        decision: string;
        value: { items: Array<Record<string, unknown>> };
      }>(
        `SELECT decision, value FROM occupancy_lease_field_reviews
          WHERE document_id = $1 AND field = 'securities'`,
        [documentId],
      );
      assert.equal(stored.rows[0]?.decision, 'corrected');
      assert.equal(stored.rows[0]?.value.items.length, 1);
      assert.equal(stored.rows[0]?.value.items[0]?.statedAmount, '12,000');

      // Confirming carries no value at all: the command copies it off the fact
      // it reads itself.
      const confirmed = await app.inject({
        method: 'POST',
        url: `${fields}/confirm`,
        headers: form,
        payload: new URLSearchParams({ factId }).toString(),
      });
      assert.equal(confirmed.statusCode, 302);
      assert.equal(confirmed.headers.location, chunks);
      const after = await pool.query<{ decision: string }>(
        `SELECT decision FROM occupancy_lease_field_reviews
          WHERE document_id = $1 AND field = 'securities'`,
        [documentId],
      );
      // One review per field, however often it is reviewed.
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0]?.decision, 'confirmed');

      // A stale extraction id is a refusal rather than a name attached to a
      // value nobody saw.
      const stale = await app.inject({
        method: 'POST',
        url: `${fields}/confirm`,
        headers: form,
        payload: new URLSearchParams({ factId: newId() }).toString(),
      });
      assert.equal(stale.statusCode, 302);
      assert.match(String(stale.headers.location), /error=conflict/);

      // A field name in a URL is checked against occupancy's registry, not
      // trusted.
      const invented = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.unit.id}/documents/${documentId}/fields/the-colour-of-the-door/confirm`,
        headers: form,
        payload: new URLSearchParams({ factId }).toString(),
      });
      assert.match(String(invented.headers.location), /error=invalid/);

      // The same guard the ingest and the extract are behind: a review writes
      // rows, so a viewer is refused and the refusal is on the record.
      const viewer = await loginAs(pool, app, 'viewer');
      const refused = await app.inject({
        method: 'POST',
        url: `${fields}/confirm`,
        headers: {
          cookie: viewer,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ factId }).toString(),
      });
      assert.equal(refused.statusCode, 302);
      assert.match(String(refused.headers.location), /error=not_allowed/);
      const refusals = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'staff.reviewLeaseField' AND outcome = 'error'
            AND error_code = 'not_allowed'`,
      );
      assert.ok((refusals.rows[0]?.n ?? 0) > 0);
      const viewerPage = await app.inject({
        method: 'GET',
        url: chunks,
        headers: { cookie: viewer },
      });
      assert.ok(!viewerPage.body.includes('/confirm'));

      // And the pairing of unit and document is checked here too.
      const crossed = await app.inject({
        method: 'POST',
        url: `/admin/units/${place.vacant.id}/documents/${documentId}/fields/securities/confirm`,
        headers: form,
        payload: new URLSearchParams({ factId }).toString(),
      });
      assert.match(String(crossed.headers.location), /error=not_found/);
    });
  });
});
