import type { Pool, PoolClient } from 'pg';
import type { ActorKind, AuditLog } from '../../kernel/audit.ts';
import type { Clock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import type { ObjectStore } from '../../kernel/objects.ts';
import type { PdfText } from '../../kernel/pdf.ts';
import { asText, validId } from '../../kernel/validate.ts';
import type { Portfolio } from '../../portfolio/contract.ts';
import { chunkLease, type LeaseChunk } from './clauses.ts';
import { documentPath } from './paths.ts';

// Lease documents, indexed per occupancy. See SPEC-occupancy.md, "Lease
// documents": the row hangs off a tenancy and never off a unit or a person,
// because the tenancy is the scope every later read is filtered by.

export const documentKinds = [
  'lease',
  'appendix',
  'guarantee',
  'other',
] as const;
export type DocumentKind = (typeof documentKinds)[number];

// Code and not a config row -- a stated exception to SPEC.md rule 4, on the
// argument staff's role matrix makes: rule 4 governs tunables, and a size cap a
// database write could raise is a memory-exhaustion lever rather than a policy.
export const maxDocumentBytes = 20 * 1024 * 1024;

// PDF alone, because slice 12.1 extracts text from a PDF and nothing else. A
// scan arrives as a PDF too; OCR is week 3's cut line, logged as manual entry.
export const documentContentType = 'application/pdf';

export interface DocumentRecord {
  id: string;
  tenancyId: string;
  kind: DocumentKind;
  objectPath: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  // What the last pass over this document found out about the document itself.
  // `ingestedAt` is null for one never read -- and it, not a chunk count, is the
  // honest answer to "has this been ingested": a document read that produced
  // nothing and a document nobody opened look identical from a count.
  ingestedAt: string | null;
  pageCount: number | null;
  imageOnlyPages: number[];
}

export interface AttachDocumentInput {
  tenancyId: string;
  kind: DocumentKind;
  contentType: string;
  bytes: Buffer;
}

export interface DocumentActor {
  kind: ActorKind;
  id?: string;
}

export interface Documents {
  attachDocument(
    input: AttachDocumentInput,
    actor: DocumentActor,
  ): Promise<DocumentRecord>;
  listDocuments(tenancyId: string): Promise<DocumentRecord[]>;
  readDocument(
    documentId: string,
  ): Promise<{ document: DocumentRecord; bytes: Buffer }>;
  ingestDocument(
    input: IngestDocumentInput,
    actor: DocumentActor,
  ): Promise<Ingestion>;
  listChunks(documentId: string): Promise<ChunkRecord[]>;
  countChunks(tenancyId: string): Promise<Record<string, number>>;
}

export interface IngestDocumentInput {
  documentId: string;
}

// What one pass over a document produced. The counts are the answer an operator
// gets on the screen, and `imageOnlyPages` is the part that keeps an incomplete
// lease honest -- see SPEC-occupancy.md, "An incomplete lease says so".
export interface Ingestion {
  documentId: string;
  tenancyId: string;
  chunks: number;
  pages: number;
  imageOnlyPages: number[];
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  tenancyId: string;
  ordinal: number;
  clauseRef: string | null;
  heading: string | null;
  pageFrom: number;
  pageTo: number;
  text: string;
  createdAt: string;
}

export interface DocumentDeps {
  pool: Pool;
  clock: Clock;
  audit: AuditLog;
  portfolio: Portfolio;
  store: ObjectStore;
  pdf: PdfText;
}

// The default when nothing wired a store. It throws rather than remembering, so
// a process that forgot to configure one cannot accept a signed contract and
// quietly drop it -- the failure a memory default would hide until someone
// clicked the document a week later.
export function createUnconfiguredStore(): ObjectStore {
  const refuse = (): never => {
    throw new KernelError('unavailable', 'no object store is configured');
  };
  return {
    put: async () => refuse(),
    read: async () => refuse(),
    describe: () => 'unconfigured',
  };
}

interface DocumentRow {
  id: string;
  tenancy_id: string;
  kind: string;
  object_path: string;
  content_type: string;
  byte_size: number;
  created_at: Date;
  ingested_at: Date | null;
  page_count: number | null;
  image_only_pages: number[] | null;
}

const columns = `id, tenancy_id, kind, object_path, content_type, byte_size,
  created_at, ingested_at, page_count, image_only_pages`;

interface ChunkRow {
  id: string;
  document_id: string;
  tenancy_id: string;
  ordinal: number;
  clause_ref: string | null;
  heading: string | null;
  page_from: number;
  page_to: number;
  text: string;
  created_at: Date;
}

const chunkColumns = `id, document_id, tenancy_id, ordinal, clause_ref, heading,
  page_from, page_to, text, created_at`;

export function validDocumentKind(
  value: unknown,
  field = 'kind',
): DocumentKind {
  if (
    typeof value !== 'string' ||
    !(documentKinds as readonly string[]).includes(value)
  ) {
    throw new KernelError(
      'invalid',
      `${field} must be one of ${documentKinds.join(', ')}`,
    );
  }
  return value as DocumentKind;
}

export function createDocuments(deps: DocumentDeps): Documents {
  const { pool, clock, audit, portfolio, store } = deps;

  return {
    async attachDocument(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.attachDocument',
          subjectId: asText(input?.tenancyId),
          // The tenancy and the shape of the file. Never the bytes, and never a
          // filename: the name the browser sent is a person's name on its way
          // into a log, which is why it is discarded rather than recorded.
          inputs: {
            tenancyId: asText(input?.tenancyId),
            kind: asText(input?.kind),
            contentType: asText(input?.contentType),
          },
        },
        async () => {
          const tenancyId = validId(input?.tenancyId, 'tenancyId');
          const kind = validDocumentKind(input?.kind);
          const contentType = normalizeContentType(input?.contentType);
          const bytes = input?.bytes;
          if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
            throw new KernelError('invalid', 'the document is empty');
          }
          if (bytes.length > maxDocumentBytes) {
            throw new KernelError('invalid', 'the document is too large', {
              maxBytes: maxDocumentBytes,
            });
          }

          const tenancy = await pool.query<{ unit_id: string }>(
            'SELECT unit_id FROM occupancy_tenancies WHERE id = $1',
            [tenancyId],
          );
          const unitId = tenancy.rows[0]?.unit_id;
          if (!unitId) {
            throw new KernelError('not_found', 'tenancy not found');
          }

          // Through portfolio's contract, so a document cannot be filed under a
          // place this module invented. Access notes are not requested.
          const unit = await portfolio.getUnit(unitId);
          const documentId = newId(clock);
          const objectPath = documentPath({
            buildingId: unit.building.id,
            unitId: unit.unit.id,
            tenancyId,
            documentId,
            kind,
          });

          // Object first, row second, deliberately. A put that succeeds with a
          // failed insert leaves an orphan object in a versioned bucket:
          // invisible, recoverable, costing storage. The reverse leaves a row
          // whose document is not there -- a lease the admin lists and cannot
          // open, which is a lie the screen renders on the system's behalf.
          await store.put(objectPath, bytes, contentType);

          const inserted = await pool.query<DocumentRow>(
            `INSERT INTO occupancy_documents
               (id, tenancy_id, kind, object_path, content_type, byte_size, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING ${columns}`,
            [
              documentId,
              tenancyId,
              kind,
              objectPath,
              contentType,
              bytes.length,
              clock.now(),
            ],
          );
          const row = inserted.rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'document could not be read');
          }
          return toDocument(row);
        },
      );
    },

    async listDocuments(tenancyId) {
      const id = validId(tenancyId, 'tenancyId');
      // Metadata only: no bytes and no store round trip, so a unit page with
      // five documents makes no calls to the bucket at all.
      const found = await pool.query<DocumentRow>(
        `SELECT ${columns} FROM occupancy_documents
          WHERE tenancy_id = $1
          ORDER BY created_at DESC, id`,
        [id],
      );
      return found.rows.map(toDocument);
    },

    async readDocument(documentId) {
      const id = validId(documentId, 'documentId');
      const found = await pool.query<DocumentRow>(
        `SELECT ${columns} FROM occupancy_documents WHERE id = $1`,
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        throw new KernelError('not_found', 'document not found');
      }
      const document = toDocument(row);
      // A row whose object has gone is `unavailable` and never empty bytes: an
      // empty PDF would render as a blank page rather than as a problem.
      const object = await store.read(document.objectPath);
      return { document, bytes: object.bytes };
    },

    async ingestDocument(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.ingestDocument',
          subjectId: asText(input?.documentId),
          // The document, and nothing out of it. The clause text is a verbatim
          // copy of a real contract, and a copy of it in audit_log would be a
          // second place it has to be deleted from at sign-off (tasks/fuses.md)
          // for no answer this row is asked to give.
          inputs: { documentId: asText(input?.documentId) },
        },
        async () => {
          const documentId = validId(input?.documentId, 'documentId');
          const found = await pool.query<DocumentRow>(
            `SELECT ${columns} FROM occupancy_documents WHERE id = $1`,
            [documentId],
          );
          const row = found.rows[0];
          if (!row) {
            throw new KernelError('not_found', 'document not found');
          }
          const document = toDocument(row);
          // The same answer readDocument gives for a row whose object has gone,
          // and for the same reason: a document of zero chunks would look like
          // a lease with nothing in it rather than a lease that is missing.
          const object = await store.read(document.objectPath);

          // `invalid` for a file that will not open, from the kernel adapter.
          const pages = await deps.pdf.pages(object.bytes);
          const { chunks, imageOnlyPages } = chunkLease(pages);

          await replaceChunks(document, chunks, {
            pageCount: pages.length,
            imageOnlyPages,
          });

          return {
            documentId: document.id,
            // Copied from the document row and never taken from a caller. It is
            // the column every retrieval query in 12.2 filters on.
            tenancyId: document.tenancyId,
            chunks: chunks.length,
            pages: pages.length,
            imageOnlyPages,
          };
        },
      );
    },

    // How many clauses each of a tenancy's documents was cut into -- so the
    // unit page can say which documents have been read and which have not,
    // which are different facts and look identical without this. Filtered by
    // tenancy_id: the same column every retrieval query in 12.2 filters on.
    async countChunks(tenancyId) {
      const id = validId(tenancyId, 'tenancyId');
      const found = await pool.query<{ document_id: string; count: string }>(
        `SELECT document_id, count(*) AS count
           FROM occupancy_document_chunks
          WHERE tenancy_id = $1
          GROUP BY document_id`,
        [id],
      );
      const counts: Record<string, number> = {};
      for (const row of found.rows) {
        counts[row.document_id] = Number(row.count);
      }
      return counts;
    },

    async listChunks(documentId) {
      const id = validId(documentId, 'documentId');
      const found = await pool.query<ChunkRow>(
        `SELECT ${chunkColumns} FROM occupancy_document_chunks
          WHERE document_id = $1
          ORDER BY ordinal`,
        [id],
      );
      return found.rows.map(toChunk);
    },
  };

  // Delete then insert, in one transaction. Chunks are *derived* data with a
  // natural key -- unlike a document, whose re-upload is a correction (11.2) --
  // so re-reading one document is a replacement rather than a second copy.
  // Either the whole re-read lands or none of it does: a half-replaced document,
  // some clauses from this pass and some from the last, is the shape that makes
  // a citation point at text no longer beside it.
  async function replaceChunks(
    document: DocumentRecord,
    chunks: LeaseChunk[],
    read: { pageCount: number; imageOnlyPages: number[] },
  ): Promise<void> {
    const now = clock.now();
    await inTransaction(pool, async (client) => {
      await client.query(
        'DELETE FROM occupancy_document_chunks WHERE document_id = $1',
        [document.id],
      );
      // In the same transaction as the chunks it describes. A row saying it was
      // read beside chunks from an earlier pass would be a worse lie than
      // either alone -- and this is the fact the screen shows tomorrow, when
      // the response that carried it is long gone.
      await client.query(
        `UPDATE occupancy_documents
            SET ingested_at = $2, page_count = $3, image_only_pages = $4
          WHERE id = $1`,
        [document.id, now, read.pageCount, read.imageOnlyPages],
      );
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO occupancy_document_chunks
             (id, document_id, tenancy_id, ordinal, clause_ref, heading,
              page_from, page_to, text, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            newId(clock),
            document.id,
            document.tenancyId,
            chunk.ordinal,
            chunk.clauseRef,
            chunk.heading,
            chunk.pageFrom,
            chunk.pageTo,
            chunk.text,
            now,
          ],
        );
      }
    });
  }
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

// A browser may send `application/pdf; charset=binary`. The parameters are not
// the type, and comparing the whole header would reject a legitimate upload.
function normalizeContentType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new KernelError('invalid', 'contentType is required');
  }
  const type = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== documentContentType) {
    throw new KernelError('invalid', 'only a PDF can be attached');
  }
  return documentContentType;
}

function toChunk(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    tenancyId: row.tenancy_id,
    ordinal: Number(row.ordinal),
    clauseRef: row.clause_ref,
    heading: row.heading,
    pageFrom: Number(row.page_from),
    pageTo: Number(row.page_to),
    text: row.text,
    createdAt: row.created_at.toISOString(),
  };
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    kind: row.kind as DocumentKind,
    objectPath: row.object_path,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    createdAt: row.created_at.toISOString(),
    ingestedAt: row.ingested_at ? row.ingested_at.toISOString() : null,
    pageCount: row.page_count === null ? null : Number(row.page_count),
    imageOnlyPages: (row.image_only_pages ?? []).map(Number),
  };
}
