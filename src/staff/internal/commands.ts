import type { Pool } from 'pg';
import type {
  AddPersonInput,
  AddPhoneInput,
  Identity,
  Person,
  PhoneLink,
} from '../../identity/contract.ts';
import { type AuditLog, createAuditLog } from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import type {
  AddPartyInput,
  AttachDocumentInput,
  DocumentRecord,
  EndTenancyInput,
  Extraction,
  ExtractTwinInput,
  IngestDocumentInput,
  Ingestion,
  LeaseFieldReview,
  Occupancy,
  OpenTenancyInput,
  Party,
  ReviewLeaseFieldInput,
  Tenancy,
} from '../../occupancy/contract.ts';
import type {
  AddAssetInput,
  AddBuildingInput,
  AddUnitInput,
  Asset,
  Building,
  Portfolio,
  Unit,
} from '../../portfolio/contract.ts';
import type { Session } from './auth.ts';
import { type Capability, requireCapability } from './roles.ts';

// The three domain modules arrive as their contract types — never their
// internals, and visible in the constructor rather than buried in a call. The
// same shape occupancy uses for the two modules it joins.
export interface StaffCommandDeps {
  identity: Identity;
  portfolio: Portfolio;
  occupancy: Occupancy;
  // The edge's own audit rows go here; the domain modules keep writing theirs.
  pool: Pool;
  audit?: AuditLog;
  clock?: Clock;
}

// Everything a staff member can change today. Each takes the session rather
// than an actor: the role that permits the command and the id that is recorded
// come from the same place, so neither can be passed in by a caller.
export interface StaffCommands {
  addPerson(input: AddPersonInput, session: Session): Promise<Person>;
  addPhone(input: AddPhoneInput, session: Session): Promise<PhoneLink>;
  addBuilding(input: AddBuildingInput, session: Session): Promise<Building>;
  addUnit(input: AddUnitInput, session: Session): Promise<Unit>;
  addAsset(input: AddAssetInput, session: Session): Promise<Asset>;
  openTenancy(input: OpenTenancyInput, session: Session): Promise<Tenancy>;
  addParty(input: AddPartyInput, session: Session): Promise<Party>;
  endTenancy(input: EndTenancyInput, session: Session): Promise<Tenancy>;
  attachDocument(
    input: AttachDocumentInput,
    session: Session,
  ): Promise<DocumentRecord>;
  // Slice 12.1. `mutate` like every other write, and no new rule: reading a
  // document into clauses writes rows, so a viewer may not do it.
  ingestDocument(
    input: IngestDocumentInput,
    session: Session,
  ): Promise<Ingestion>;
  // Slice 13.1. `mutate` for the fourth time and no new rule: reading a lease
  // into fields writes rows, so a viewer may not do it -- and it is the same
  // guard whether the rows come from a parser or from a model.
  extractTwin(input: ExtractTwinInput, session: Session): Promise<Extraction>;
  // Slice 13.2. `mutate` for the fifth time and no new rule -- confirming a
  // field writes a row, so a viewer may not, and it is the same guard whether
  // the row records a parser, a model or a person.
  reviewLeaseField(
    input: ReviewLeaseFieldInput,
    session: Session,
  ): Promise<LeaseFieldReview>;
}

export function createStaffCommands(deps: StaffCommandDeps): StaffCommands {
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(deps.pool, clock);

  // One shape for all twelve. The capability check runs *inside* the audited
  // work, so a refusal leaves an `error` row with code not_allowed rather than
  // no row at all — the pattern identity established for rejected commands —
  // and it runs *before* the module is reached, so a viewer never touches
  // domain state.
  function guard<T>(
    action: string,
    capability: Capability,
    session: Session,
    run: (actor: { kind: 'staff'; id: string }) => Promise<T>,
  ): Promise<T> {
    return audit.around(
      {
        actorKind: 'staff',
        actorId: session.operator.id,
        actorRole: session.operator.role,
        action: `staff.${action}`,
        // The decision, not the payload: the module's own row already holds the
        // arguments, and recording tenant details twice doubles the PII for no
        // extra answer. This row exists to say who was allowed, and why.
        inputs: { capability },
      },
      async () => {
        requireCapability(session.operator.role, capability);
        return run({ kind: 'staff', id: session.operator.id });
      },
    );
  }

  return {
    addPerson: (input, session) =>
      guard('addPerson', 'mutate', session, (actor) =>
        deps.identity.addPerson(input, actor),
      ),
    addPhone: (input, session) =>
      guard('addPhone', 'mutate', session, (actor) =>
        deps.identity.addPhone(input, actor),
      ),
    addBuilding: (input, session) =>
      guard('addBuilding', 'mutate', session, (actor) =>
        deps.portfolio.addBuilding(input, actor),
      ),
    addUnit: (input, session) =>
      guard('addUnit', 'mutate', session, (actor) =>
        deps.portfolio.addUnit(input, actor),
      ),
    addAsset: (input, session) =>
      guard('addAsset', 'mutate', session, (actor) =>
        deps.portfolio.addAsset(input, actor),
      ),
    openTenancy: (input, session) =>
      guard('openTenancy', 'mutate', session, (actor) =>
        deps.occupancy.openTenancy(input, actor),
      ),
    addParty: (input, session) =>
      guard('addParty', 'mutate', session, (actor) =>
        deps.occupancy.addParty(input, actor),
      ),
    endTenancy: (input, session) =>
      guard('endTenancy', 'mutate', session, (actor) =>
        deps.occupancy.endTenancy(input, actor),
      ),
    attachDocument: (input, session) =>
      guard('attachDocument', 'mutate', session, (actor) =>
        deps.occupancy.attachDocument(input, actor),
      ),
    ingestDocument: (input, session) =>
      guard('ingestDocument', 'mutate', session, (actor) =>
        deps.occupancy.ingestDocument(input, actor),
      ),
    extractTwin: (input, session) =>
      guard('extractTwin', 'mutate', session, (actor) =>
        deps.occupancy.extractTwin(input, actor),
      ),
    reviewLeaseField: (input, session) =>
      guard('reviewLeaseField', 'mutate', session, (actor) =>
        deps.occupancy.reviewLeaseField(input, actor),
      ),
  };
}
