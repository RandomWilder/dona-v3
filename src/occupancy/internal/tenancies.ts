import type { Pool } from 'pg';
import {
  createIdentity,
  type Identity,
  type Person,
} from '../../identity/contract.ts';
import {
  type ActorKind,
  type AuditLog,
  createAuditLog,
} from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { asText, optionalText, validId } from '../../kernel/validate.ts';
import {
  createPortfolio,
  type Portfolio,
  type UnitView,
} from '../../portfolio/contract.ts';
import { optionalDate, validDate } from './dates.ts';
import {
  type OccupancyRole,
  sortRoles,
  type TenancyAccess,
  tenancyAccess,
  validRole,
} from './roles.ts';

const maxLabel = 50;

// The tenants are in Israel and the dates in the lease are Israeli dates.
// Between 22:00 and midnight local time a UTC comparison has already rolled the
// date over, which would tell a tenant on the last evening of their lease that
// they have no tenancy. See SPEC-occupancy.md, "What current means".
const tenancyZone = 'Asia/Jerusalem';
const today = `($1::timestamptz AT TIME ZONE '${tenancyZone}')::date`;

export interface Actor {
  kind: ActorKind;
  id?: string;
}

export interface Tenancy {
  id: string;
  unitId: string;
  startsOn: string;
  endsOn: string | null;
  parkingSpot: string | null;
  storageUnit: string | null;
}

export interface Party {
  tenancyId: string;
  personId: string;
  role: OccupancyRole;
}

export interface TenancyParty {
  personId: string;
  roles: OccupancyRole[];
  access: TenancyAccess;
}

export interface TenancyView {
  tenancy: Tenancy;
  parties: TenancyParty[];
  unit: UnitView;
}

// One person's standing on one tenancy, with the place it points at.
export interface ResolvedTenancy {
  tenancy: Tenancy;
  roles: OccupancyRole[];
  access: TenancyAccess;
  unit: UnitView;
}

export interface OccupancyResolution {
  person: Person;
  // Current only, ordered by startsOn. A list and never a guess: a person
  // renting two flats is a fact, and "the most recent" is the one shape that
  // can silently answer about the wrong flat.
  tenancies: ResolvedTenancy[];
}

export interface OpenTenancyInput {
  unitId: string;
  startsOn: string;
  endsOn?: string | null;
  parkingSpot?: string | null;
  storageUnit?: string | null;
}

export interface AddPartyInput {
  tenancyId: string;
  personId: string;
  role: OccupancyRole;
}

export interface EndTenancyInput {
  tenancyId: string;
  endsOn: string;
}

export interface Occupancy {
  openTenancy(input: OpenTenancyInput, actor: Actor): Promise<Tenancy>;
  addParty(input: AddPartyInput, actor: Actor): Promise<Party>;
  endTenancy(input: EndTenancyInput, actor: Actor): Promise<Tenancy>;
  getTenancy(tenancyId: string): Promise<TenancyView>;
  // Slice 10.1: the join read from the other side. resolveByPhone enters at a
  // person and arrives at a place; the admin unit view enters at a place.
  findCurrentTenancy(unitId: string): Promise<TenancyView | null>;
  resolveByPhone(phone: string): Promise<OccupancyResolution | null>;
}

export interface OccupancyDeps {
  pool: Pool;
  clock?: Clock;
  audit?: AuditLog;
  // Injected so the dependency is visible in the constructor rather than buried
  // in a join. Both arrive through their contract.ts and nothing else.
  identity?: Identity;
  portfolio?: Portfolio;
}

interface TenancyRow {
  id: string;
  unit_id: string;
  starts_on: string;
  ends_on: string | null;
  parking_spot: string | null;
  storage_unit: string | null;
}

// `date` columns come back from pg as JS Date objects, which would drag the
// process timezone into an answer. Read them as text instead.
const tenancyColumns = `id, unit_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(ends_on, 'YYYY-MM-DD') AS ends_on, parking_spot, storage_unit`;

export function createOccupancy(deps: OccupancyDeps): Occupancy {
  const { pool } = deps;
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(pool, clock);
  const identity = deps.identity ?? createIdentity({ pool, clock, audit });
  const portfolio = deps.portfolio ?? createPortfolio({ pool, clock, audit });

  // The whole view for one tenancy. Both entry points into it — by tenancy id
  // and by unit — assemble it here rather than one calling the other through
  // `this`, which in an object literal is a binding waiting to be broken by a
  // destructured import.
  async function tenancyView(tenancy: Tenancy): Promise<TenancyView> {
    const parties = await pool.query<{ person_id: string; role: string }>(
      `SELECT person_id, role FROM occupancy_parties
        WHERE tenancy_id = $1
        ORDER BY person_id, role`,
      [tenancy.id],
    );
    return {
      tenancy,
      parties: groupParties(parties.rows),
      // Without access notes: an entry code must not reach a caller that did
      // not ask, the rule portfolio.getUnit enforces from its side.
      unit: await portfolio.getUnit(tenancy.unitId),
    };
  }

  async function readTenancy(tenancyId: string): Promise<Tenancy> {
    const found = await pool.query<TenancyRow>(
      `SELECT ${tenancyColumns} FROM occupancy_tenancies WHERE id = $1`,
      [tenancyId],
    );
    const row = found.rows[0];
    // An id must have been issued by something, so a miss is a dangling
    // reference — the getUnit rule, not the findByPhone rule.
    if (!row) {
      throw new KernelError('not_found', 'tenancy not found');
    }
    return toTenancy(row);
  }

  return {
    async openTenancy(input, actor) {
      // No subject id: on a repeat the caller gets the existing tenancy, whose
      // id is not the one this call would have minted.
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.openTenancy',
          inputs: {
            unitId: asText(input?.unitId),
            startsOn: asText(input?.startsOn),
            endsOn: asText(input?.endsOn),
          },
        },
        async () => {
          const unitId = validId(input?.unitId, 'unitId');
          const startsOn = validDate(input?.startsOn, 'startsOn');
          const endsOn = optionalDate(input?.endsOn, 'endsOn');
          const parkingSpot = optionalText(
            input?.parkingSpot,
            'parkingSpot',
            maxLabel,
          );
          const storageUnit = optionalText(
            input?.storageUnit,
            'storageUnit',
            maxLabel,
          );
          if (endsOn !== null && endsOn < startsOn) {
            throw new KernelError('invalid', 'endsOn is before startsOn');
          }

          // Through portfolio's contract: an unknown unit becomes a sentence
          // rather than a foreign-key driver error.
          await portfolio.getUnit(unitId);

          // A tenancy *is* one unit and one start date, so the unique index is
          // the idempotency and this module needs no intent keys at all.
          const inserted = await pool.query<TenancyRow>(
            `INSERT INTO occupancy_tenancies
               (id, unit_id, starts_on, ends_on, parking_spot, storage_unit, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (unit_id, starts_on) DO NOTHING
             RETURNING ${tenancyColumns}`,
            [
              newId(clock),
              unitId,
              startsOn,
              endsOn,
              parkingSpot,
              storageUnit,
              clock.now(),
            ],
          );
          const row =
            inserted.rows[0] ??
            (
              await pool.query<TenancyRow>(
                `SELECT ${tenancyColumns} FROM occupancy_tenancies
                  WHERE unit_id = $1 AND starts_on = $2`,
                [unitId, startsOn],
              )
            ).rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'tenancy could not be read');
          }
          return toTenancy(row);
        },
      );
    },

    async addParty(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.addParty',
          subjectId: asText(input?.tenancyId),
          inputs: {
            tenancyId: asText(input?.tenancyId),
            personId: asText(input?.personId),
            role: input?.role,
          },
        },
        async () => {
          const tenancyId = validId(input?.tenancyId, 'tenancyId');
          const personId = validId(input?.personId, 'personId');
          const role = validRole(input?.role);

          await readTenancy(tenancyId);
          const person = await pool.query(
            'SELECT 1 FROM identity_people WHERE id = $1',
            [personId],
          );
          if (person.rowCount === 0) {
            throw new KernelError('not_found', 'person not found');
          }

          // Idempotent on the primary key, as identity's kinds are.
          await pool.query(
            `INSERT INTO occupancy_parties (tenancy_id, person_id, role, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenancy_id, person_id, role) DO NOTHING`,
            [tenancyId, personId, role, clock.now()],
          );
          return { tenancyId, personId, role };
        },
      );
    },

    async endTenancy(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'occupancy.endTenancy',
          subjectId: asText(input?.tenancyId),
          inputs: {
            tenancyId: asText(input?.tenancyId),
            endsOn: asText(input?.endsOn),
          },
        },
        async () => {
          const tenancyId = validId(input?.tenancyId, 'tenancyId');
          const endsOn = validDate(input?.endsOn, 'endsOn');

          const current = await readTenancy(tenancyId);
          if (endsOn < current.startsOn) {
            throw new KernelError('invalid', 'endsOn is before startsOn');
          }
          // Saying the same thing twice is the same tenancy. Saying a different
          // thing is a correction, and a correction has to say so.
          if (current.endsOn !== null && current.endsOn !== endsOn) {
            throw new KernelError('conflict', 'tenancy already ended');
          }
          if (current.endsOn === endsOn) {
            return current;
          }

          const updated = await pool.query<TenancyRow>(
            `UPDATE occupancy_tenancies SET ends_on = $2
              WHERE id = $1
              RETURNING ${tenancyColumns}`,
            [tenancyId, endsOn],
          );
          const row = updated.rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'tenancy could not be read');
          }
          return toTenancy(row);
        },
      );
    },

    async getTenancy(tenancyId) {
      return tenancyView(await readTenancy(validId(tenancyId, 'tenancyId')));
    },

    async findCurrentTenancy(unitId) {
      const id = validId(unitId, 'unitId');
      // The same `today` the whole module shares — not a second copy of the
      // predicate. Two statements of "what current means" is how the boundary
      // comes back three hours late on one path and not the other.
      //
      // starts_on DESC because (unit_id, starts_on) does not by itself prevent
      // two overlapping tenancies on one unit (see SPEC-occupancy.md, "Not yet
      // in place"). That plurality would be corruption rather than a fact — the
      // opposite of a person renting two flats, which is why 7.1 refused to
      // collapse *that* — so the view shows the latest and the shape is
      // asserted deliberately rather than left to chance.
      const found = await pool.query<TenancyRow>(
        `SELECT ${tenancyColumns}
           FROM occupancy_tenancies t
          WHERE t.unit_id = $2
            AND t.starts_on <= ${today}
            AND (t.ends_on IS NULL OR t.ends_on >= ${today})
          ORDER BY t.starts_on DESC, t.id
          LIMIT 1`,
        [clock.now(), id],
      );
      const row = found.rows[0];
      // null, not not_found: the unit exists and nobody lives there right now,
      // which is an ordinary state the view renders as a vacancy. A unit id
      // naming nothing at all is portfolio.getUnit's not_found, raised before
      // this is reached.
      if (!row) {
        return null;
      }
      return tenancyView(toTenancy(row));
    },

    async resolveByPhone(phone) {
      // phone → person. identity owns the normalisation, so every spelling of
      // one number arrives here as the same person.
      const person = await identity.findByPhone(phone);
      // Nobody holds this number: an answer, not a failure.
      if (!person) {
        return null;
      }

      // person → current tenancies. Scoped by person_id, so a tenancy this
      // person is not a party to cannot appear no matter what else is in the
      // table — this is the query layer SPEC.md's isolation rule names.
      const found = await pool.query<TenancyRow & { roles: OccupancyRole[] }>(
        `SELECT ${tenancyColumns},
                array_agg(p.role ORDER BY p.role) AS roles
           FROM occupancy_tenancies t
           JOIN occupancy_parties p ON p.tenancy_id = t.id
          WHERE p.person_id = $2
            AND t.starts_on <= ${today}
            AND (t.ends_on IS NULL OR t.ends_on >= ${today})
          GROUP BY t.id
          ORDER BY t.starts_on, t.id`,
        [clock.now(), person.id],
      );

      const tenancies: ResolvedTenancy[] = [];
      for (const row of found.rows) {
        const roles = sortRoles(row.roles);
        // tenancy → unit, without access notes: an entry code must not reach a
        // resolution by accident. A caller who needs one asks portfolio for it,
        // having first decided it is entitled to.
        const unit = await portfolio.getUnit(row.unit_id);
        tenancies.push({
          tenancy: toTenancy(row),
          roles,
          access: tenancyAccess(roles),
          unit,
        });
      }
      return { person, tenancies };
    },
  };
}

function toTenancy(row: TenancyRow): Tenancy {
  return {
    id: row.id,
    unitId: row.unit_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    parkingSpot: row.parking_spot,
    storageUnit: row.storage_unit,
  };
}

// One row per role in the table, one entry per person in the answer.
function groupParties(
  rows: Array<{ person_id: string; role: string }>,
): TenancyParty[] {
  const byPerson = new Map<string, OccupancyRole[]>();
  for (const row of rows) {
    const roles = byPerson.get(row.person_id) ?? [];
    roles.push(row.role as OccupancyRole);
    byPerson.set(row.person_id, roles);
  }
  return [...byPerson].map(([personId, roles]) => {
    const sorted = sortRoles(roles);
    return { personId, roles: sorted, access: tenancyAccess(sorted) };
  });
}
