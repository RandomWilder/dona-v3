import type { Pool } from 'pg';
import type { ActorKind, AuditLog } from '../../kernel/audit.ts';
import type { Clock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import type { ObjectStore } from '../../kernel/objects.ts';
import { asText, validId } from '../../kernel/validate.ts';
import type { Portfolio } from '../../portfolio/contract.ts';
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
}

export interface DocumentDeps {
  pool: Pool;
  clock: Clock;
  audit: AuditLog;
  portfolio: Portfolio;
  store: ObjectStore;
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
}

const columns = `id, tenancy_id, kind, object_path, content_type, byte_size, created_at`;

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
  };
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

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    tenancyId: row.tenancy_id,
    kind: row.kind as DocumentKind,
    objectPath: row.object_path,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    createdAt: row.created_at.toISOString(),
  };
}
