import type { Person } from '../../identity/contract.ts';
import { type AuditLog, createAuditLog } from '../../kernel/audit.ts';
import { systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import type {
  ChunkRecord,
  DocumentRecord,
  OccupancyResolution,
  TenancyView,
} from '../../occupancy/contract.ts';
import type {
  Building,
  BuildingView,
  UnitView,
} from '../../portfolio/contract.ts';
import type { Session } from './auth.ts';
import type { StaffCommandDeps } from './commands.ts';
import { requireCapability } from './roles.ts';

// The reads behind the admin views, checked against the same matrix the
// mutations are. Beside `commands.ts` and not inside it because the audit rule
// differs — see below, and SPEC-staff.md, "The guarded read surface".
//
// Every read here checks `read`, which until slice 10.1 was the one row of the
// matrix with nothing exercising it.

// What a unit's page shows: the place, who is in it now, and their names. The
// last of those is why this is composed here rather than in `occupancy` — that
// module returns parties as ids, correctly, since a name is `identity`'s fact.
export interface UnitDetail {
  unit: UnitView;
  tenancy: TenancyView | null;
  people: Person[];
  // Empty for a vacant flat, because documents hang off the tenancy and a
  // vacancy has none. Metadata only -- the bytes are a second request.
  documents: DocumentRecord[];
  // How many clauses each document was cut into, by document id. A document
  // missing from this map has not been ingested, which is a different fact
  // from a document that produced nothing (slice 12.1).
  chunkCounts: Record<string, number>;
}

// What the chunks page shows: the place it was reached through, the document
// it belongs to, and the clauses it was cut into.
export interface DocumentChunks {
  unit: UnitView;
  document: DocumentRecord;
  chunks: ChunkRecord[];
}

export interface PersonDetail {
  person: Person;
  phones: string[];
  occupancy: OccupancyResolution | null;
}

export interface StaffQueries {
  listBuildings(session: Session): Promise<Building[]>;
  getBuilding(buildingId: string, session: Session): Promise<BuildingView>;
  findByPhone(
    phone: string,
    session: Session,
  ): Promise<OccupancyResolution | null>;
  getUnitDetail(unitId: string, session: Session): Promise<UnitDetail>;
  // Audited like the other detail reads: a lease is exactly the record a
  // privacy request means when it asks who opened a tenant's file.
  getDocument(
    documentId: string,
    session: Session,
  ): Promise<{ document: DocumentRecord; bytes: Buffer }>;
  // Audited like the bytes are, and for the same reason: the chunks are the
  // lease's own words, so opening them is the same privacy event as opening
  // the PDF (slice 12.1).
  getDocumentChunks(
    unitId: string,
    documentId: string,
    session: Session,
  ): Promise<DocumentChunks>;
  getPersonDetail(personId: string, session: Session): Promise<PersonDetail>;
}

export function createStaffQueries(deps: StaffCommandDeps): StaffQueries {
  const clock = deps.clock ?? systemClock;
  const audit: AuditLog = deps.audit ?? createAuditLog(deps.pool, clock);

  // A list read: guarded, and no audit row. The rule 9.1 wrote is that every
  // staff *action* leaves a record, and the honest reading of that for reads is
  // not "every page load" — a row per nav click makes audit_log mostly
  // navigation, and the week-2 demo asks the trail to tell two sessions apart.
  function guard<T>(session: Session, run: () => Promise<T>): Promise<T> {
    requireCapability(session.operator.role, 'read');
    return run();
  }

  // A detail read: audited, because this is the screen a privacy request means
  // when it asks who opened a tenant's record — a name, a number and a unit on
  // one page. Guard inside `audit.around`, as commands.ts does, so a refused
  // read leaves an `error` row rather than none.
  function guardAudited<T>(
    action: string,
    subjectId: string,
    session: Session,
    run: () => Promise<T>,
  ): Promise<T> {
    return audit.around(
      {
        actorKind: 'staff',
        actorId: session.operator.id,
        actorRole: session.operator.role,
        action: `staff.${action}`,
        subjectId,
        // The subject id and nothing else. Copying the name and phone that were
        // on the screen would make the trail a second store of the data it
        // exists to protect.
        inputs: { capability: 'read' },
      },
      async () => {
        requireCapability(session.operator.role, 'read');
        return run();
      },
    );
  }

  return {
    listBuildings: (session) =>
      guard(session, () => deps.portfolio.listBuildings()),

    getBuilding: (buildingId, session) =>
      // Without access notes: the properties view is a browse screen, and an
      // entry code is asked for by the screen that needs it (week 5's dispatch).
      guard(session, () => deps.portfolio.getBuilding(buildingId)),

    findByPhone: (phone, session) =>
      guard(session, () => deps.occupancy.resolveByPhone(phone)),

    getUnitDetail: (unitId, session) =>
      guardAudited('getUnitDetail', unitId, session, async () => {
        // getUnit first: it raises not_found for a unit id that names nothing,
        // which is what lets findCurrentTenancy's null mean "empty flat" rather
        // than "no such flat".
        const unit = await deps.portfolio.getUnit(unitId);
        const tenancy = await deps.occupancy.findCurrentTenancy(unitId);
        const people = tenancy
          ? await deps.identity.getPeople(
              tenancy.parties.map((p) => p.personId),
            )
          : [];
        const documents = tenancy
          ? await deps.occupancy.listDocuments(tenancy.tenancy.id)
          : [];
        const chunkCounts = tenancy
          ? await deps.occupancy.countChunks(tenancy.tenancy.id)
          : {};
        return { unit, tenancy, people, documents, chunkCounts };
      }),

    getDocument: (documentId, session) =>
      guardAudited('getDocument', documentId, session, () =>
        deps.occupancy.readDocument(documentId),
      ),

    getDocumentChunks: (unitId, documentId, session) =>
      guardAudited('getDocumentChunks', documentId, session, async () => {
        const unit = await deps.portfolio.getUnit(unitId);
        // The document has to be this unit's, checked here rather than assumed
        // from the URL: a pair of ids in a link is a caller-supplied claim, and
        // 11.2's rule is that the tenancy a document hangs off is resolved on
        // the server. This is that rule read from the other direction.
        const tenancy = await deps.occupancy.findCurrentTenancy(unitId);
        const document = tenancy
          ? (await deps.occupancy.listDocuments(tenancy.tenancy.id)).find(
              (row) => row.id === documentId,
            )
          : undefined;
        if (!document) {
          throw new KernelError('not_found', 'document not found');
        }
        return {
          unit,
          document,
          chunks: await deps.occupancy.listChunks(document.id),
        };
      }),

    getPersonDetail: (personId, session) =>
      guardAudited('getPersonDetail', personId, session, async () => {
        const [person] = await deps.identity.getPeople([personId]);
        if (!person) {
          throw new KernelError('not_found', 'person not found');
        }
        const phones = await deps.identity.listPhones(personId);
        // Through the person's own number rather than by a second query on the
        // join: resolveByPhone is the one path scoped by person that the whole
        // system's isolation rests on, and this view must not grow a second.
        const first = phones[0]?.phone;
        return {
          person,
          phones: phones.map((p) => p.phone),
          occupancy: first ? await deps.occupancy.resolveByPhone(first) : null,
        };
      }),
  };
}
