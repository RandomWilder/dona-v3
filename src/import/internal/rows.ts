import type { Pool } from 'pg';
import {
  createIdentity,
  type Identity,
  normalizePhone,
} from '../../identity/contract.ts';
import type { ActorKind } from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { type ErrorCode, KernelError } from '../../kernel/errors.ts';
import {
  createOccupancy,
  type Occupancy,
  type OccupancyRole,
  occupancyRoles,
  optionalDate,
  validDate,
} from '../../occupancy/contract.ts';
import { createPortfolio, type Portfolio } from '../../portfolio/contract.ts';
import { type CsvRow, parseCsv } from './csv.ts';

// One row is one party of one tenancy. That is what dissolves the ambiguity the
// real lease showed -- two tenants, two mobile numbers, no mapping between them
// (docs/reference/lease-template-donadom.md). A row that carries one person and
// one phone leaves the importer no room to guess which is whose.
export const requiredColumns = [
  'building_name',
  'city',
  'street',
  'house_number',
  'unit_label',
  'starts_on',
  'person_name',
  'phone',
  'role',
] as const;

export const optionalColumns = [
  'floor',
  'ends_on',
  'parking_spot',
  'storage_unit',
] as const;

export interface Actor {
  kind: ActorKind;
  id?: string;
}

export interface Rejection {
  // The line in the source file, so a reject names itself to whoever is
  // looking at the spreadsheet.
  line: number;
  code: ErrorCode;
  reason: string;
}

export interface ImportReport {
  read: number;
  applied: number;
  rejected: Rejection[];
  // False for a dry run. See SPEC-import.md on what a dry run does not catch.
  committed: boolean;
}

export interface ImportDeps {
  pool: Pool;
  clock?: Clock;
  identity?: Identity;
  portfolio?: Portfolio;
  occupancy?: Occupancy;
}

export interface ImportOptions {
  commit?: boolean;
  actor?: Actor;
}

interface PlannedRow {
  buildingName: string;
  city: string;
  street: string;
  houseNumber: string;
  unitLabel: string;
  floor: number | null;
  startsOn: string;
  endsOn: string | null;
  parkingSpot: string | null;
  storageUnit: string | null;
  personName: string;
  phone: string;
  role: OccupancyRole;
}

export async function importTenants(
  text: unknown,
  deps: ImportDeps,
  options: ImportOptions = {},
): Promise<ImportReport> {
  // A structural failure aborts: after a ragged row or an unterminated quote
  // every later line number is meaningless, and line numbers are the whole
  // value of the reject list.
  const table = parseCsv(text);
  const missing = requiredColumns.filter(
    (name) => !table.header.includes(name),
  );
  if (missing.length > 0) {
    throw new KernelError('invalid', 'csv is missing required columns', {
      missing,
    });
  }

  const clock = deps.clock ?? systemClock;
  const commit = options.commit === true;
  const actor: Actor = options.actor ?? { kind: 'system', id: 'import' };
  const identity = deps.identity ?? createIdentity({ pool: deps.pool, clock });
  const portfolio =
    deps.portfolio ?? createPortfolio({ pool: deps.pool, clock });
  const occupancy =
    deps.occupancy ??
    createOccupancy({ pool: deps.pool, clock, identity, portfolio });

  const rejected: Rejection[] = [];
  let applied = 0;

  for (const row of table.rows) {
    let planned: PlannedRow;
    try {
      planned = planRow(row);
    } catch (error) {
      rejected.push(toRejection(row.line, error));
      continue;
    }
    if (!commit) {
      applied += 1;
      continue;
    }
    try {
      await applyRow(planned, { identity, portfolio, occupancy }, actor);
      applied += 1;
    } catch (error) {
      // A bad row names itself and the good rows around it still land.
      rejected.push(toRejection(row.line, error));
    }
  }

  return { read: table.rows.length, applied, rejected, committed: commit };
}

// Validation only -- no database, no writes. Every rule here is the module's
// own, reached through its contract, so a row this accepts is a row the
// commands accept.
function planRow(row: CsvRow): PlannedRow {
  const at = (column: string): string => (row.values[column] ?? '').trim();
  const blankToNull = (column: string): string | null => {
    const value = at(column);
    return value === '' ? null : value;
  };

  for (const column of requiredColumns) {
    if (at(column) === '') {
      throw new KernelError('invalid', `${column} is empty`);
    }
  }

  const role = at('role');
  if (!occupancyRoles.includes(role as OccupancyRole)) {
    throw new KernelError(
      'invalid',
      `role must be one of ${occupancyRoles.join(', ')}, not "${role}"`,
    );
  }

  const startsOn = validDate(at('starts_on'), 'starts_on');
  const endsOn = optionalDate(blankToNull('ends_on'), 'ends_on');
  if (endsOn !== null && endsOn < startsOn) {
    throw new KernelError('invalid', 'ends_on is before starts_on');
  }

  const floorText = blankToNull('floor');
  let floor: number | null = null;
  if (floorText !== null) {
    floor = Number(floorText);
    if (!Number.isInteger(floor)) {
      throw new KernelError(
        'invalid',
        `floor is not a whole number: "${floorText}"`,
      );
    }
  }

  return {
    buildingName: at('building_name'),
    city: at('city'),
    street: at('street'),
    houseNumber: at('house_number'),
    unitLabel: at('unit_label'),
    floor,
    startsOn,
    endsOn,
    parkingSpot: blankToNull('parking_spot'),
    storageUnit: blankToNull('storage_unit'),
    personName: at('person_name'),
    // Any spelling in, E.164 out. This is also the person's idempotency key
    // below, so it has to be the normalised form.
    phone: normalizePhone(at('phone')),
    role: role as OccupancyRole,
  };
}

async function applyRow(
  row: PlannedRow,
  modules: {
    identity: Identity;
    portfolio: Portfolio;
    occupancy: Occupancy;
  },
  actor: Actor,
): Promise<void> {
  const { identity, portfolio, occupancy } = modules;

  // Every one of these is idempotent on a natural key, which is what makes
  // re-running the file a no-op rather than something this loop has to
  // remember. See SPEC-portfolio.md and SPEC-occupancy.md.
  const building = await portfolio.addBuilding(
    {
      name: row.buildingName,
      city: row.city,
      street: row.street,
      houseNumber: row.houseNumber,
    },
    actor,
  );
  const unit = await portfolio.addUnit(
    { buildingId: building.id, label: row.unitLabel, floor: row.floor },
    actor,
  );

  // The intent key is the normalised phone, not the row number: a row number
  // moves when the file is re-sorted and would mint a second person for
  // someone who already exists. See SPEC-identity.md, amended in this slice.
  const person = await identity.addPerson(
    {
      intentKey: `import:person:${row.phone}`,
      displayName: row.personName,
      kinds: ['tenant'],
    },
    actor,
  );
  await identity.addPhone({ personId: person.id, phone: row.phone }, actor);

  const tenancy = await occupancy.openTenancy(
    {
      unitId: unit.id,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      parkingSpot: row.parkingSpot,
      storageUnit: row.storageUnit,
    },
    actor,
  );
  await occupancy.addParty(
    { tenancyId: tenancy.id, personId: person.id, role: row.role },
    actor,
  );
}

function toRejection(line: number, error: unknown): Rejection {
  if (error instanceof KernelError) {
    return { line, code: error.code, reason: error.message };
  }
  // An unexpected failure is still a reject rather than a crash, but it must
  // not leak an internal message -- the run may be reading real tenant data.
  return { line, code: 'unavailable', reason: 'unexpected failure' };
}
