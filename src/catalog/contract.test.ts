import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { fixedClock } from '../kernel/clock.ts';
import { embeddingColumnDimensions } from '../kernel/config.ts';
import { createFakeEmbedder } from '../kernel/embeddings.ts';
import type { KernelError } from '../kernel/errors.ts';
import { newId } from '../kernel/ids.ts';
import { migratedPoolOrNull, skipReason } from '../kernel/pg-support.ts';
import {
  createCatalog,
  type GuidanceActor,
  type GuidanceFile,
  type GuidanceSource,
} from './contract.ts';

// Contract tests: every command goes through contract.ts. The pool is used only
// to inspect what the commands left behind, never to shortcut one.

const actor: GuidanceActor = { kind: 'staff', id: 'contract-test' };
const clock = fixedClock(new Date('2026-09-01T09:00:00.000Z'));

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

// A source of exactly the files a test wants. The database persists between
// runs, so every test invents its own slug.
function source(files: GuidanceFile[]): GuidanceSource {
  return {
    list: async () => files,
    describe: () => 'test source',
  };
}

function file(slug: string, title: string, body: string): GuidanceFile {
  return {
    slug,
    path: `docs/guidance/${slug}.md`,
    markdown: `# ${title}\n\n${body}\n`,
  };
}

function build(pool: Pool, files: GuidanceFile[]) {
  return createCatalog({
    pool,
    clock,
    embedder: createFakeEmbedder(embeddingColumnDimensions),
    source: source(files),
  });
}

describe('catalog guidance', () => {
  it('loads a policy document and finds the section that answers a question', async (t) => {
    await withPool(t, async (pool) => {
      const slug = `hours-${newId()}`;
      // Guidance is org-wide and the database persists between runs, so the
      // *text* has to be unique too and not only the slug: the fake embedder is
      // deterministic, so an identical section left by an earlier run sits at
      // the same distance and either may win. Found by running the suite twice.
      const open = `המשרד פתוח בימים ראשון עד חמישי בין 09:00 ל-17:00 (${slug}).`;
      const catalog = build(pool, [
        file(
          slug,
          `נוהל פנייה ${slug}`,
          [
            '## שעות פעילות',
            open,
            '',
            '## דרכי פנייה',
            `פנייה בכתב היא הדרך המועדפת (${slug}).`,
          ].join('\n'),
        ),
      ]);
      const synced = await catalog.syncGuidance(actor);
      assert.equal(synced.documents, 1);
      assert.equal(synced.chunks, 2);
      assert.equal(synced.skipped, 0);

      // The fake embedder is deterministic on the text rather than semantic, so
      // the query is the section's own text: what this proves is the wiring and
      // the citation, not that the model is good at Hebrew.
      const hits = await catalog.searchGuidance({ query: open });
      assert.equal(hits[0]?.headingRef, `נוהל פנייה ${slug} § שעות פעילות`);
      assert.equal(hits[0]?.title, `נוהל פנייה ${slug}`);
    });
  });

  it('skips a file whose text has not changed, and re-reads one that has', async (t) => {
    await withPool(t, async (pool) => {
      const slug = `policy-${newId()}`;
      const first = file(slug, `נוהל ${slug}`, '## סעיף\nהטקסט המקורי.');
      const again = build(pool, [first]);
      assert.equal((await again.syncGuidance(actor)).documents, 1);

      // Same bytes: nothing is embedded a second time.
      const repeat = await again.syncGuidance(actor);
      assert.equal(repeat.skipped, 1);
      assert.equal(repeat.documents, 0);

      // Changed bytes: replaced, not appended, and the old section is gone.
      const edited = build(pool, [
        file(slug, `נוהל ${slug}`, '## סעיף חדש\nהטקסט המעודכן.'),
      ]);
      const third = await edited.syncGuidance(actor);
      assert.equal(third.documents, 1);
      assert.equal(third.skipped, 0);

      const rows = await pool.query<{ heading_ref: string }>(
        `SELECT c.heading_ref FROM catalog_guidance_chunks c
           JOIN catalog_guidance_documents d ON d.id = c.document_id
          WHERE d.slug = $1
          ORDER BY c.ordinal`,
        [slug],
      );
      assert.deepEqual(
        rows.rows.map((row) => row.heading_ref),
        [`נוהל ${slug} § סעיף חדש`],
      );
    });
  });

  it('keeps one document per slug however its title is edited', async (t) => {
    await withPool(t, async (pool) => {
      const slug = `retitled-${newId()}`;
      await build(pool, [
        file(slug, `שם ראשון ${slug}`, '## סעיף\nטקסט.'),
      ]).syncGuidance(actor);
      await build(pool, [
        file(slug, `שם שני ${slug}`, '## סעיף\nטקסט אחר.'),
      ]).syncGuidance(actor);
      const rows = await pool.query<{ title: string }>(
        'SELECT title FROM catalog_guidance_documents WHERE slug = $1',
        [slug],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0]?.title, `שם שני ${slug}`);
    });
  });

  it('refuses an empty query rather than ranking the whole corpus', async (t) => {
    await withPool(t, async (pool) => {
      const catalog = build(pool, []);
      await assert.rejects(
        catalog.searchGuidance({ query: '   ' }),
        (error: KernelError) => error.code === 'invalid',
      );
      await assert.rejects(
        catalog.searchGuidance({ query: 'שאלה', limit: 0 }),
        (error: KernelError) => error.code === 'invalid',
      );
    });
  });

  it('audits the sync without copying a word of the document into the log', async (t) => {
    await withPool(t, async (pool) => {
      const slug = `audited-${newId()}`;
      const secret = 'משפט שאסור לו להופיע ביומן הביקורת.';
      await build(pool, [
        file(slug, `נוהל ${slug}`, `## סעיף\n${secret}`),
      ]).syncGuidance(actor);
      const rows = await pool.query<{ inputs: unknown }>(
        `SELECT inputs FROM audit_log
          WHERE action = 'catalog.syncGuidance'
          ORDER BY at DESC LIMIT 1`,
      );
      const inputs = JSON.stringify(rows.rows[0]?.inputs ?? {});
      assert.ok(!inputs.includes(secret));
      assert.match(inputs, /test source/);
    });
  });

  it('refuses to sync when nothing wired a source', async (t) => {
    await withPool(t, async (pool) => {
      const catalog = createCatalog({
        pool,
        clock,
        embedder: createFakeEmbedder(embeddingColumnDimensions),
      });
      await assert.rejects(
        catalog.syncGuidance(actor),
        (error: KernelError) => error.code === 'unavailable',
      );
    });
  });
});
