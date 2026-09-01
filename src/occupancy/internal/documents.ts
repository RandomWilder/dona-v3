import type { Pool, PoolClient } from 'pg';
import type { ActorKind, AuditLog } from '../../kernel/audit.ts';
import type { Clock } from '../../kernel/clock.ts';
import {
  readEmbeddingSettings,
  readExtractionSettings,
  type Settings,
} from '../../kernel/config.ts';
import type { Embedder } from '../../kernel/embeddings.ts';
import { KernelError } from '../../kernel/errors.ts';
import type { Extractor } from '../../kernel/extraction.ts';
import { newId } from '../../kernel/ids.ts';
import type { ObjectStore } from '../../kernel/objects.ts';
import type { PdfText } from '../../kernel/pdf.ts';
import { asText, validId } from '../../kernel/validate.ts';
import type { Portfolio } from '../../portfolio/contract.ts';
import { chunkLease, isRetrievable, type LeaseChunk } from './clauses.ts';
import { applyEdits, EditError } from './edits.ts';
import { documentPath } from './paths.ts';
import {
  buildRequest,
  type Confidence,
  type ExtractedField,
  type LeaseField,
  leaseFieldSpec,
  leaseFields,
  type ReviewDecision,
  readReply,
  selectClauses,
  validLeaseField,
  validReviewDecision,
} from './twin.ts';

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

// How many clauses a search returns unless the caller says otherwise. Enough for
// week 4's agent to have a second candidate when the first does not answer the
// question, few enough that a prompt built from them stays readable.
export const defaultSearchLimit = 8;
export const maxSearchLimit = 50;

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
  searchClauses(input: SearchClausesInput): Promise<ClauseHit[]>;
  // Slice 13.1: the lease's fields, each pointing at the clause it was read
  // out of. Its own command and not a step of ingesting: ingestion is
  // deterministic and already slow, and this is a judgement a human reviews.
  extractTwin(
    input: ExtractTwinInput,
    actor: DocumentActor,
  ): Promise<Extraction>;
  listLeaseFacts(documentId: string): Promise<LeaseFact[]>;
  // Slice 13.2: the human's answer to one of those fields. The only command in
  // this module whose row is not derived from a document -- which is why it is
  // the only one whose row survives the document being read again.
  reviewLeaseField(
    input: ReviewLeaseFieldInput,
    actor: DocumentActor,
  ): Promise<LeaseFieldReview>;
  listFieldReviews(documentId: string): Promise<LeaseFieldReview[]>;
}

export interface ReviewLeaseFieldInput {
  documentId: string;
  field: string;
  // The extraction this review is a statement about. A version token and not an
  // id the caller is trusted with: everything else here is resolved server-side,
  // and this exists so that confirming a value someone re-extracted a moment ago
  // raises `conflict` instead of recording agreement with a number the operator
  // never saw.
  factId: string;
  decision: string;
  // A correction only. Paths into the stored value, from `editableGroups`, and
  // the rows to remove. Never a value: a caller that could post a value could
  // post one carrying a citation nobody checked.
  edits?: Record<string, string>;
  drops?: string[];
}

// One field, as a human left it. `value` is what they stand behind and
// `reviewedValue` is what the extraction said at the time -- the pair is what
// lets `stands` be answered later without keeping a copy of the extraction.
export interface LeaseFieldReview {
  id: string;
  documentId: string;
  tenancyId: string;
  field: LeaseField;
  decision: ReviewDecision;
  value: Record<string, unknown>;
  reviewedValue: Record<string, unknown>;
  reviewedByKind: string;
  reviewedById: string;
  reviewedAt: string;
  // The document's current fact for this field still holds the value this review
  // was made about. False is not an error: it is a re-extraction having changed
  // the ground under a human's statement, and the screen says so rather than
  // showing a confirmation beside a number nobody confirmed.
  stands: boolean;
}

export interface ExtractTwinInput {
  documentId: string;
}

// What one pass over a document's clauses produced. `attempted` counts the
// fields that had clauses worth sending, so `attempted - fields` is the honest
// count of "the clauses were read and did not say" -- which is a different fact
// from a field nobody looked for.
export interface Extraction {
  documentId: string;
  tenancyId: string;
  fields: number;
  attempted: number;
  model: string;
}

// One extracted field, and the clause it can be read against. Nothing reaches
// this shape without a citation naming a clause that was actually sent.
export interface LeaseFact {
  id: string;
  documentId: string;
  tenancyId: string;
  field: LeaseField;
  value: Record<string, unknown>;
  chunkId: string;
  clauseRef: string | null;
  pageFrom: number;
  pageTo: number;
  confidence: Confidence;
  model: string;
  extractedAt: string;
}

export interface SearchClausesInput {
  // Required, with no default and no optional form. There is no code path here
  // that searches every lease -- an "all tenancies" search is not a feature this
  // module declines to expose, it is a shape that does not exist.
  tenancyId: string;
  query: string;
  limit?: number;
}

// What a citation needs: where the text is, and what it says.
export interface ClauseHit {
  chunkId: string;
  documentId: string;
  clauseRef: string | null;
  heading: string | null;
  pageFrom: number;
  pageTo: number;
  text: string;
  distance: number;
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
  // How many of them retrieval can reach. Since 14.1b this is not `chunks`: a
  // cover page and a bare heading are stored and not embedded, and reporting
  // one number for both would say a lease is searchable in places it is not.
  indexed: number;
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
  embedder: Embedder;
  extractor: Extractor;
  settings: Settings;
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

interface FactRow {
  id: string;
  document_id: string;
  tenancy_id: string;
  field: string;
  value: Record<string, unknown>;
  chunk_id: string;
  clause_ref: string | null;
  page_from: number;
  page_to: number;
  confidence: string;
  model: string;
  extracted_at: Date;
}

const factColumns = `id, document_id, tenancy_id, field, value, chunk_id,
  clause_ref, page_from, page_to, confidence, model, extracted_at`;

interface ReviewRow {
  id: string;
  document_id: string;
  tenancy_id: string;
  field: string;
  decision: string;
  value: Record<string, unknown>;
  reviewed_value: Record<string, unknown>;
  reviewed_by_kind: string;
  reviewed_by_id: string;
  reviewed_at: Date;
}

const reviewColumns = `id, document_id, tenancy_id, field, decision, value,
  reviewed_value, reviewed_by_kind, reviewed_by_id, reviewed_at`;

// The same columns, qualified, for the one read that joins the fact beside them.
const reviewColumnsFromR = `r.id, r.document_id, r.tenancy_id, r.field,
  r.decision, r.value, r.reviewed_value, r.reviewed_by_kind, r.reviewed_by_id,
  r.reviewed_at`;

// A form posts strings and only strings, and a review's edits arrive as one.
// Anything that is not a string pair is dropped here rather than reaching
// `applyEdits`, which would have to grow an opinion about request shapes.
function editsOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const edits: Record<string, string> = {};
  for (const [path, typed] of Object.entries(value)) {
    if (typeof typed === 'string') {
      edits[path] = typed;
    }
  }
  return edits;
}

function dropsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((row): row is string => typeof row === 'string')
    : [];
}

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

          // Which chunks retrieval may return. Everything is stored; only
          // these are embedded, and the predicate lives in clauses.ts with the
          // rest of what a lease is. See SPEC-occupancy.md, "an uncitable chunk
          // is stored and never indexed".
          const indexed = chunks.filter(isRetrievable);

          // Embedded before the transaction opens, not inside it: this is a
          // network call to a third party, and holding a Postgres transaction
          // open across one is how a slow provider becomes a lock nobody can
          // explain. The guarantee the transaction is there for survives
          // anyway -- a failed embedding throws here, before a single row is
          // deleted, so a document is never half-indexed and never left with
          // clauses that have no vectors.
          const embedding = await embedChunks(indexed);

          await replaceChunks(document, chunks, indexed, embedding, {
            pageCount: pages.length,
            imageOnlyPages,
          });

          return {
            documentId: document.id,
            // Copied from the document row and never taken from a caller. It is
            // the column every retrieval query in 12.2 filters on.
            tenancyId: document.tenancyId,
            chunks: chunks.length,
            indexed: indexed.length,
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

    async searchClauses(input) {
      const tenancyId = validId(input?.tenancyId, 'tenancyId');
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) {
        throw new KernelError(
          'invalid',
          'a search needs something to look for',
        );
      }
      const limit = validLimit(input?.limit);

      const { model } = await readEmbeddingSettings(deps.settings);
      const [vector] = await deps.embedder.embed([query]);
      if (!vector) {
        throw new KernelError('unavailable', 'the query could not be embedded');
      }

      // The isolation filter, and the reason `tenancy_id` is a column on this
      // table rather than a join away: it is a WHERE on the table being
      // searched, which a query cannot be written without noticing.
      const found = await pool.query<ChunkRow & { distance: number }>(
        `SELECT c.id, c.document_id, c.tenancy_id, c.ordinal, c.clause_ref,
                c.heading, c.page_from, c.page_to, c.text, c.created_at,
                e.embedding <=> $2::vector AS distance
           FROM occupancy_chunk_embeddings e
           JOIN occupancy_document_chunks c ON c.id = e.chunk_id
          WHERE e.tenancy_id = $1 AND e.model = $3
          ORDER BY e.embedding <=> $2::vector
          LIMIT $4`,
        [tenancyId, toVector(vector), model, limit],
      );

      // An empty list for a tenancy with nothing indexed *and* for one that is
      // not yours. Deliberately identical: a distinct error would confirm the
      // tenancy exists, which is an isolation leak wearing an error code.
      return found.rows.map((row) => ({
        chunkId: row.id,
        documentId: row.document_id,
        clauseRef: row.clause_ref,
        heading: row.heading,
        pageFrom: Number(row.page_from),
        pageTo: Number(row.page_to),
        text: row.text,
        distance: Number(row.distance),
      }));
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

    async extractTwin(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.extractTwin',
          subjectId: asText(input?.documentId),
          // The document, and nothing out of it. A field's value quotes the
          // contract, and audit_log is not a fourth place a real lease lands
          // (tasks/fuses.md counts them).
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

          const stored = await pool.query<ChunkRow>(
            `SELECT ${chunkColumns} FROM occupancy_document_chunks
              WHERE document_id = $1
              ORDER BY ordinal`,
            [document.id],
          );
          const chunks = stored.rows.map(toChunk);
          if (chunks.length === 0) {
            // `invalid` and not an empty result: extraction reads clauses, and
            // there are none to read. A document nobody ingested and a lease
            // that says nothing about its own term are different facts.
            throw new KernelError(
              'invalid',
              'the document has no clauses to read',
            );
          }

          // Per call, not at boot: a model the account cannot serve -- or one
          // that reasons for minutes while a browser waits -- has to be
          // correctable with a config row (SPEC-kernel.md).
          const { model, reasoningEffort } = await readExtractionSettings(
            deps.settings,
          );

          // One call per field, each carrying only the clauses that field could
          // be in -- and the calls run *together*. They are independent, and
          // running them in sequence made the request take their sum: five at
          // the provider's default reasoning effort exceeded Cloud Run's
          // 300-second timeout on the first staging press, which the operator
          // saw as a blank page. Concurrently, the request costs the slowest
          // call rather than all of them.
          const asked = leaseFields
            .map((field) => ({ field, clauses: selectClauses(field, chunks) }))
            .filter((call) => call.clauses.length > 0);

          // `Promise.all` rejects on the first failure, which is the behaviour
          // this needs: a pass replaces the document's facts wholesale, so a
          // pass with a failed call is not a pass. It throws before a row is
          // deleted, leaving the previous extraction intact -- the guarantee
          // 12.2 gives for a failed embedding.
          const replies = await Promise.all(
            asked.map((call) =>
              deps.extractor.extract(
                buildRequest(call.field, model, call.clauses, reasoningEffort),
              ),
            ),
          );

          const extracted: ExtractedField[] = [];
          for (const [at, call] of asked.entries()) {
            // Believed only if its citation names a clause that was sent.
            const read = readReply(call.field, replies[at], call.clauses);
            if (read) {
              extracted.push(read);
            }
          }
          const attempted = asked.length;

          await replaceFacts(document, extracted, model);

          return {
            documentId: document.id,
            // Copied from the document row and never taken from a caller, as
            // everywhere else in this module.
            tenancyId: document.tenancyId,
            fields: extracted.length,
            attempted,
            model,
          };
        },
      );
    },

    async listLeaseFacts(documentId) {
      const id = validId(documentId, 'documentId');
      const found = await pool.query<FactRow>(
        `SELECT ${factColumns} FROM occupancy_lease_facts
          WHERE document_id = $1`,
        [id],
      );
      // In the registry's order rather than the table's. The order the fields
      // are declared in is the order a lease is read in, and SQL has no opinion
      // about which of `term` and `rent` comes first.
      return found.rows
        .map(toFact)
        .sort(
          (a, b) => leaseFields.indexOf(a.field) - leaseFields.indexOf(b.field),
        );
    },

    async reviewLeaseField(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.reviewLeaseField',
          subjectId: asText(input?.documentId),
          // Which field, and what was decided about it. Never the value and
          // never the edits: a correction is the contract's own words retyped,
          // and the review table is already the fifth place they live
          // (tasks/fuses.md counts them). audit_log is not going to be a sixth.
          inputs: {
            documentId: asText(input?.documentId),
            field: asText(input?.field),
            decision: asText(input?.decision),
          },
        },
        async () => {
          const documentId = validId(input?.documentId, 'documentId');
          const field = validLeaseField(input?.field);
          const factId = validId(input?.factId, 'factId');
          const decision = validReviewDecision(input?.decision);
          // A review with no actor is not a record of who reviewed it, which is
          // the whole of what this table is for.
          const actorId = asText(actor?.id)?.trim();
          if (!actorId) {
            throw new KernelError('invalid', 'a review needs an actor');
          }

          const found = await pool.query<FactRow>(
            `SELECT ${factColumns} FROM occupancy_lease_facts
              WHERE document_id = $1 AND field = $2`,
            [documentId, field],
          );
          const row = found.rows[0];
          if (!row) {
            // `not_found` and not `invalid`: the field is a real field of a real
            // document, and there is nothing extracted to have an opinion about.
            throw new KernelError('not_found', 'the field has not been read');
          }
          const fact = toFact(row);
          if (fact.id !== factId) {
            // Somebody read the lease again between this page rendering and this
            // press. Recording agreement now would attach a human's name to a
            // value they never saw.
            throw new KernelError(
              'conflict',
              'the field was read again since the page was opened',
            );
          }

          const value =
            decision === 'confirmed'
              ? fact.value
              : await correctedValue(fact, input);

          const now = clock.now();
          const written = await pool.query<ReviewRow>(
            `INSERT INTO occupancy_lease_field_reviews
               (id, document_id, tenancy_id, field, decision, value,
                reviewed_value, reviewed_by_kind, reviewed_by_id, reviewed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (document_id, field) DO UPDATE SET
               decision = EXCLUDED.decision,
               value = EXCLUDED.value,
               reviewed_value = EXCLUDED.reviewed_value,
               reviewed_by_kind = EXCLUDED.reviewed_by_kind,
               reviewed_by_id = EXCLUDED.reviewed_by_id,
               reviewed_at = EXCLUDED.reviewed_at
             RETURNING ${reviewColumns}`,
            [
              newId(clock),
              fact.documentId,
              // Copied from the fact, which copied it from the document. A
              // tenancy id has never come from a caller in this module.
              fact.tenancyId,
              field,
              decision,
              JSON.stringify(value),
              // What the review is a statement *about*. The same value for a
              // correction as for a confirmation: both are answers to what the
              // extraction said, and only the answer differs.
              JSON.stringify(fact.value),
              actor.kind,
              actorId,
              now,
            ],
          );
          const stored = written.rows[0];
          if (!stored) {
            throw new KernelError('unavailable', 'the review was not stored');
          }
          // True by construction: `reviewed_value` was just read off the fact
          // this call checked the id of.
          return toReview(stored, true);
        },
      );
    },

    async listFieldReviews(documentId) {
      const id = validId(documentId, 'documentId');
      const found = await pool.query<ReviewRow & { stands: boolean }>(
        `SELECT ${reviewColumnsFromR},
                (f.value IS NOT NULL AND f.value = r.reviewed_value) AS stands
           FROM occupancy_lease_field_reviews r
           LEFT JOIN occupancy_lease_facts f
             ON f.document_id = r.document_id AND f.field = r.field
          WHERE r.document_id = $1`,
        [id],
      );
      // In the registry's order, as the facts are: the two lists are read
      // side by side on one screen, and a screen that had to sort them itself
      // would be a second copy of an order this module already states.
      return found.rows
        .map((row) => toReview(row, row.stands === true))
        .sort(
          (a, b) => leaseFields.indexOf(a.field) - leaseFields.indexOf(b.field),
        );
    },
  };

  // A correction, applied to the value this command read rather than to one a
  // caller posted -- and then held to exactly the check the model's answer was.
  // `parse` re-derives every `clauseRef` from the chunk its row cites and drops
  // a row citing a clause this document does not have, so a human cannot write a
  // citation any more than the model can invent one.
  async function correctedValue(
    fact: LeaseFact,
    input: ReviewLeaseFieldInput,
  ): Promise<Record<string, unknown>> {
    let edited: Record<string, unknown>;
    try {
      edited = applyEdits(
        fact.value,
        editsOf(input?.edits),
        dropsOf(input?.drops),
      );
    } catch (error) {
      if (error instanceof EditError) {
        throw new KernelError('invalid', error.message);
      }
      throw error;
    }

    const stored = await pool.query<ChunkRow>(
      `SELECT ${chunkColumns} FROM occupancy_document_chunks
        WHERE document_id = $1
        ORDER BY ordinal`,
      [fact.documentId],
    );
    const sent = new Map(
      stored.rows.map(toChunk).map((chunk) => [chunk.id, chunk] as const),
    );
    const value = leaseFieldSpec(fact.field).parse(edited, sent);
    if (value === null) {
      // Emptying every row is a deletion, and there is no way to delete a
      // field: a lease that states nothing and a field nobody could read are
      // different facts, and this would render as the first.
      throw new KernelError(
        'invalid',
        'the correction leaves the field stating nothing',
      );
    }
    return value;
  }

  // Delete then insert, in one transaction. Chunks are *derived* data with a
  // natural key -- unlike a document, whose re-upload is a correction (11.2) --
  // so re-reading one document is a replacement rather than a second copy.
  // Either the whole re-read lands or none of it does: a half-replaced document,
  // some clauses from this pass and some from the last, is the shape that makes
  // a citation point at text no longer beside it.
  // The vectors the clauses will be found by. Returns them beside the model that
  // produced them, because the model id is part of the embedding row's key: a
  // later model change adds a second set rather than overwriting this one.
  async function embedChunks(
    chunks: LeaseChunk[],
  ): Promise<{ model: string; vectors: number[][] }> {
    const { model } = await readEmbeddingSettings(deps.settings);
    if (chunks.length === 0) {
      return { model, vectors: [] };
    }
    const vectors = await deps.embedder.embed(chunks.map((c) => c.text));
    if (vectors.length !== chunks.length) {
      // Pairing a clause with another clause's vector is a silent corruption:
      // every answer afterwards cites the wrong text and nothing looks broken.
      throw new KernelError(
        'unavailable',
        'the embedder returned the wrong count',
        {
          expected: chunks.length,
          received: vectors.length,
        },
      );
    }
    return { model, vectors };
  }

  async function replaceChunks(
    document: DocumentRecord,
    chunks: LeaseChunk[],
    indexed: LeaseChunk[],
    embedding: { model: string; vectors: number[][] },
    read: { pageCount: number; imageOnlyPages: number[] },
  ): Promise<void> {
    const now = clock.now();
    // Keyed by ordinal rather than by position, because the two lists are no
    // longer the same length: pairing a clause with another clause's vector is
    // the silent corruption `embedChunks` counts against, and an index into the
    // wrong list is how it would arrive.
    const vectors = new Map(
      indexed.map((chunk, at) => [chunk.ordinal, embedding.vectors[at]]),
    );
    await inTransaction(pool, async (client) => {
      // The embeddings go with them, by ON DELETE CASCADE on the chunk: an
      // embedding is derived from a clause and is meaningless without it.
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
        const chunkId = newId(clock);
        await client.query(
          `INSERT INTO occupancy_document_chunks
             (id, document_id, tenancy_id, ordinal, clause_ref, heading,
              page_from, page_to, text, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            chunkId,
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
        const vector = vectors.get(chunk.ordinal);
        if (!vector) {
          // A chunk that was deliberately not indexed is stored and skipped.
          // One that should have had a vector and has none is still the
          // corruption this guard has always been here to stop.
          if (isRetrievable(chunk)) {
            throw new KernelError('unavailable', 'a clause has no vector', {
              ordinal: chunk.ordinal,
            });
          }
          continue;
        }
        await client.query(
          `INSERT INTO occupancy_chunk_embeddings
             (chunk_id, tenancy_id, model, embedding, created_at)
           VALUES ($1, $2, $3, $4::vector, $5)`,
          [chunkId, document.tenancyId, embedding.model, toVector(vector), now],
        );
      }
    });
  }

  // Delete then insert, in one transaction, as chunks are -- facts are derived
  // data with a natural key, `UNIQUE (document_id, field)`, so re-extracting is
  // a replacement rather than a second copy. A field this pass did not produce
  // is a field this document no longer claims: leaving yesterday's value beside
  // today's would be a twin nobody could date.
  async function replaceFacts(
    document: DocumentRecord,
    fields: ExtractedField[],
    model: string,
  ): Promise<void> {
    const now = clock.now();
    await inTransaction(pool, async (client) => {
      await client.query(
        'DELETE FROM occupancy_lease_facts WHERE document_id = $1',
        [document.id],
      );
      for (const field of fields) {
        await client.query(
          `INSERT INTO occupancy_lease_facts
             (id, document_id, tenancy_id, field, value, chunk_id, clause_ref,
              page_from, page_to, confidence, model, extracted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            newId(clock),
            document.id,
            document.tenancyId,
            field.field,
            JSON.stringify(field.value),
            field.chunkId,
            field.clauseRef,
            field.pageFrom,
            field.pageTo,
            field.confidence,
            model,
            now,
          ],
        );
      }
    });
  }
}

function toReview(row: ReviewRow, stands: boolean): LeaseFieldReview {
  return {
    id: row.id,
    documentId: row.document_id,
    tenancyId: row.tenancy_id,
    field: row.field as LeaseField,
    decision: row.decision as ReviewDecision,
    value: row.value,
    reviewedValue: row.reviewed_value,
    reviewedByKind: row.reviewed_by_kind,
    reviewedById: row.reviewed_by_id,
    reviewedAt: row.reviewed_at.toISOString(),
    stands,
  };
}

function toFact(row: FactRow): LeaseFact {
  return {
    id: row.id,
    documentId: row.document_id,
    tenancyId: row.tenancy_id,
    field: row.field as LeaseField,
    value: row.value,
    chunkId: row.chunk_id,
    clauseRef: row.clause_ref,
    pageFrom: Number(row.page_from),
    pageTo: Number(row.page_to),
    confidence: row.confidence as Confidence,
    model: row.model,
    extractedAt: row.extracted_at.toISOString(),
  };
}

// pgvector's text input: '[0.1,0.2,…]'. Built here rather than passed as an
// array, because node-postgres would send a Postgres array and the cast would
// fail on a type nobody asked for.
function toVector(values: number[]): string {
  return `[${values.join(',')}]`;
}

function validLimit(value: unknown): number {
  if (value === undefined || value === null) {
    return defaultSearchLimit;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maxSearchLimit
  ) {
    throw new KernelError('invalid', 'limit is out of range', {
      max: maxSearchLimit,
    });
  }
  return value;
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
