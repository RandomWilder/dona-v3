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
  EndTenancyInput,
  Occupancy,
  OpenTenancyInput,
  Party,
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
}

export function createStaffCommands(deps: StaffCommandDeps): StaffCommands {
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(deps.pool, clock);

  // One shape for all eight. The capability check runs *inside* the audited
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
  };
}
