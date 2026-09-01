import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  type ActorKind,
  type AuditLog,
  createAuditLog,
} from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import {
  createSettings,
  readEmbeddingSettings,
  type Settings,
} from '../../kernel/config.ts';
import {
  createUnconfiguredEmbedder,
  type Embedder,
} from '../../kernel/embeddings.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { chunkGuidance, type GuidanceChunk } from './guidance.ts';

// The office's own policy text, retrievable and citable. See SPEC-catalog.md,
// "Guidance documents": org-wide, so there is no tenancy column here at all,
// and the isolation rule is honoured by the column not existing rather than by
// remembering to filter it.

// How many sections a search returns unless the caller says otherwise. Fewer
// than occupancy's eight: policy is the fallback corpus, reached only when the
// lease grounded nothing, and a long list of near-misses is what a refusal is
// supposed to prevent.
export const defaultGuidanceLimit = 5;
export const maxGuidanceLimit = 50;

export interface GuidanceActor {
  kind: ActorKind;
  id?: string;
}

/** One markdown file, as the source handed it over. */
export interface GuidanceFile {
  /** The file's identity across syncs, independent of its title. */
  slug: string;
  /** Where it came from, for a human reading the row. */
  path: string;
  markdown: string;
}

/**
 * Where policy text comes from. A port, so the module is testable without a
 * filesystem -- the seam `PdfText` already is for occupancy.
 */
export interface GuidanceSource {
  list(): Promise<GuidanceFile[]>;
  describe(): string;
}

export interface GuidanceRecord {
  id: string;
  slug: string;
  title: string;
  sourcePath: string;
  ingestedAt: string;
  chunks: number;
}

// What one pass over the source produced. `skipped` is the honest count of
// files whose checksum had not moved -- a different fact from a file that was
// read and produced nothing, and the number that makes running the sync often
// cheap rather than merely safe.
export interface GuidanceSync {
  documents: number;
  chunks: number;
  skipped: number;
  model: string;
}

export interface SearchGuidanceInput {
  query: string;
  limit?: number;
}

/** What a citation needs: where the text is, and what it says. */
export interface GuidanceHit {
  chunkId: string;
  documentId: string;
  title: string;
  headingRef: string;
  heading: string | null;
  text: string;
  distance: number;
}

export interface Catalog {
  syncGuidance(actor: GuidanceActor): Promise<GuidanceSync>;
  listGuidance(): Promise<GuidanceRecord[]>;
  searchGuidance(input: SearchGuidanceInput): Promise<GuidanceHit[]>;
}

export interface CatalogDeps {
  pool: Pool;
  clock?: Clock;
  audit?: AuditLog;
  settings?: Settings;
  /** Absent, every command that needs one refuses rather than returning zeros. */
  embedder?: Embedder;
  /** Absent, `syncGuidance` has nothing to read and says so. */
  source?: GuidanceSource;
}

// The default when nothing wired a source. It throws rather than returning an
// empty list, for the reason `createUnconfiguredStore` does in occupancy: a sync
// that silently read no files would look exactly like a company with no
// policies. The embedder's absent form is the kernel's own, which refuses every
// call rather than returning zeros.
function unconfiguredSource(): GuidanceSource {
  return {
    list: async () => {
      throw new KernelError('unavailable', 'no guidance source is configured');
    },
    describe: () => 'unconfigured',
  };
}

interface DocumentRow {
  id: string;
  slug: string;
  title: string;
  source_path: string;
  checksum: string;
  ingested_at: Date;
}

interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  heading_ref: string;
  heading: string | null;
  text: string;
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const pool = deps.pool;
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(pool, clock);
  const settings = deps.settings ?? createSettings(pool);
  const embedder = deps.embedder ?? createUnconfiguredEmbedder();
  const source = deps.source ?? unconfiguredSource();

  return {
    async syncGuidance(actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'catalog.syncGuidance',
          // The source, and nothing out of it. Policy text is ours rather than
          // a tenant's, and audit_log is still not the place to keep a copy of
          // a document that already lives in git.
          inputs: { source: source.describe() },
        },
        async () => {
          const files = await source.list();
          const { model } = await readEmbeddingSettings(settings);

          let documents = 0;
          let chunks = 0;
          let skipped = 0;

          for (const file of files) {
            const checksum = createHash('sha256')
              .update(file.markdown)
              .digest('hex');
            const existing = await pool.query<DocumentRow>(
              `SELECT id, slug, title, source_path, checksum, ingested_at
                 FROM catalog_guidance_documents WHERE slug = $1`,
              [file.slug],
            );
            const row = existing.rows[0];
            // Identical text produces identical vectors. Paying a provider to
            // confirm that on every run is what would make this command
            // expensive to run often, and a command that is expensive to run
            // often is one that stops being run.
            if (row && row.checksum === checksum) {
              skipped += 1;
              continue;
            }

            const parsed = chunkGuidance(file.markdown);
            // Outside the transaction, as occupancy's ingest is: a network call
            // held inside one is a lock nobody can explain, and a failure here
            // throws before a single row is deleted.
            const vectors = await embed(parsed.chunks);

            await inTransaction(pool, async (client) => {
              const now = clock.now();
              const documentId = row?.id ?? newId(clock);
              if (row) {
                await client.query(
                  `UPDATE catalog_guidance_documents
                      SET title = $2, source_path = $3, checksum = $4,
                          ingested_at = $5
                    WHERE id = $1`,
                  [documentId, parsed.title, file.path, checksum, now],
                );
                // Replacement, never an append: `(document_id, ordinal)` is the
                // natural key, so a section deleted from the markdown is a
                // section the system stops claiming. The embeddings go with the
                // chunks by ON DELETE CASCADE.
                await client.query(
                  'DELETE FROM catalog_guidance_chunks WHERE document_id = $1',
                  [documentId],
                );
              } else {
                await client.query(
                  `INSERT INTO catalog_guidance_documents
                     (id, slug, title, source_path, checksum, ingested_at,
                      created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    documentId,
                    file.slug,
                    parsed.title,
                    file.path,
                    checksum,
                    now,
                    now,
                  ],
                );
              }

              for (const [at, chunk] of parsed.chunks.entries()) {
                const chunkId = newId(clock);
                await client.query(
                  `INSERT INTO catalog_guidance_chunks
                     (id, document_id, ordinal, heading_ref, heading, text,
                      created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    chunkId,
                    documentId,
                    chunk.ordinal,
                    chunk.headingRef,
                    chunk.heading,
                    chunk.text,
                    now,
                  ],
                );
                const vector = vectors[at];
                if (!vector) {
                  throw new KernelError(
                    'unavailable',
                    'a guidance section has no vector',
                    { ordinal: chunk.ordinal },
                  );
                }
                await client.query(
                  `INSERT INTO catalog_guidance_embeddings
                     (chunk_id, model, embedding, created_at)
                   VALUES ($1, $2, $3::vector, $4)`,
                  [chunkId, model, toVector(vector), now],
                );
              }
            });

            documents += 1;
            chunks += parsed.chunks.length;
          }

          return { documents, chunks, skipped, model };
        },
      );
    },

    async listGuidance() {
      const found = await pool.query<DocumentRow & { chunks: string }>(
        `SELECT d.id, d.slug, d.title, d.source_path, d.checksum,
                d.ingested_at, count(c.id) AS chunks
           FROM catalog_guidance_documents d
           LEFT JOIN catalog_guidance_chunks c ON c.document_id = d.id
          GROUP BY d.id
          ORDER BY d.title`,
      );
      return found.rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        sourcePath: row.source_path,
        ingestedAt: row.ingested_at.toISOString(),
        chunks: Number(row.chunks),
      }));
    },

    async searchGuidance(input) {
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) {
        throw new KernelError(
          'invalid',
          'a search needs something to look for',
        );
      }
      const limit = validLimit(input?.limit);
      const { model } = await readEmbeddingSettings(settings);
      const [vector] = await embedder.embed([query]);
      if (!vector) {
        throw new KernelError('unavailable', 'the query could not be embedded');
      }

      // No tenancy filter, and not because one was forgotten. Guidance is text
      // the company wrote about its own operations; nothing in these tables came
      // from a person, a lease or a case. See SPEC-catalog.md, "Why it cannot
      // live in occupancy".
      const found = await pool.query<
        ChunkRow & { title: string; distance: number }
      >(
        `SELECT c.id, c.document_id, c.ordinal, c.heading_ref, c.heading,
                c.text, d.title, e.embedding <=> $1::vector AS distance
           FROM catalog_guidance_embeddings e
           JOIN catalog_guidance_chunks c ON c.id = e.chunk_id
           JOIN catalog_guidance_documents d ON d.id = c.document_id
          WHERE e.model = $2
          ORDER BY e.embedding <=> $1::vector
          LIMIT $3`,
        [toVector(vector), model, limit],
      );
      return found.rows.map((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        title: row.title,
        headingRef: row.heading_ref,
        heading: row.heading,
        text: row.text,
        distance: Number(row.distance),
      }));
    },
  };

  async function embed(chunks: GuidanceChunk[]): Promise<number[][]> {
    if (chunks.length === 0) {
      return [];
    }
    const vectors = await embedder.embed(chunks.map((chunk) => chunk.text));
    if (vectors.length !== chunks.length) {
      // Pairing a section with another section's vector is a silent corruption:
      // every answer afterwards cites the wrong heading and nothing looks broken.
      throw new KernelError(
        'unavailable',
        'the embedder returned the wrong count',
        { expected: chunks.length, received: vectors.length },
      );
    }
    return vectors;
  }
}

function validLimit(limit: unknown): number {
  if (limit === undefined || limit === null) {
    return defaultGuidanceLimit;
  }
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maxGuidanceLimit
  ) {
    throw new KernelError('invalid', 'limit is out of range', {
      min: 1,
      max: maxGuidanceLimit,
    });
  }
  return limit;
}

// pgvector's text form. The driver has no vector type, so the value is built
// here rather than left to a cast that would round it.
function toVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

async function inTransaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
