import type { Pool } from 'pg';
import {
  type ActorKind,
  type AuditLog,
  createAuditLog,
} from '../../kernel/audit.ts';
import { type Clock, systemClock } from '../../kernel/clock.ts';
import { KernelError } from '../../kernel/errors.ts';
import { newId } from '../../kernel/ids.ts';
import { addressKey, unitKey } from './keys.ts';

export const assetKinds = [
  'boiler',
  'solar_heater',
  'air_conditioner',
  'lift',
  'intercom',
  'gate',
  'water_pump',
  'electrical_panel',
  'other',
] as const;
export type AssetKind = (typeof assetKinds)[number];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxName = 200;
const maxLabel = 50;
const maxNotes = 2000;
const minFloor = -10;
const maxFloor = 200;

export interface Actor {
  kind: ActorKind;
  id?: string;
}

export interface Building {
  id: string;
  name: string;
  city: string;
  street: string;
  houseNumber: string;
  // Present only when a read asked for it. See SPEC-portfolio.md.
  accessNotes?: string | null;
}

export interface Unit {
  id: string;
  buildingId: string;
  label: string;
  floor: number | null;
  accessNotes?: string | null;
}

export interface Asset {
  id: string;
  buildingId: string;
  unitId: string | null;
  kind: AssetKind;
  label: string | null;
  notes: string | null;
}

// An asset seen from a unit: a lift is in scope for apartment 3 without
// pretending to be apartment 3's.
export interface ScopedAsset {
  id: string;
  kind: AssetKind;
  label: string | null;
  notes: string | null;
  scope: 'unit' | 'building';
}

export interface UnitView {
  unit: Unit;
  building: Building;
  assets: ScopedAsset[];
}

export interface AddBuildingInput {
  name: string;
  city: string;
  street: string;
  houseNumber: string;
  accessNotes?: string | null;
}

export interface AddUnitInput {
  buildingId: string;
  label: string;
  floor?: number | null;
  accessNotes?: string | null;
}

export interface AddAssetInput {
  buildingId: string;
  unitId?: string | null;
  kind: AssetKind;
  label?: string | null;
  notes?: string | null;
}

export interface GetUnitOptions {
  includeAccessNotes?: boolean;
}

export interface Portfolio {
  addBuilding(input: AddBuildingInput, actor: Actor): Promise<Building>;
  addUnit(input: AddUnitInput, actor: Actor): Promise<Unit>;
  addAsset(input: AddAssetInput, actor: Actor): Promise<Asset>;
  getUnit(unitId: string, options?: GetUnitOptions): Promise<UnitView>;
}

export interface PortfolioDeps {
  pool: Pool;
  clock?: Clock;
  audit?: AuditLog;
}

interface BuildingRow {
  id: string;
  name: string;
  city: string;
  street: string;
  house_number: string;
  access_notes: string | null;
}

interface UnitRow {
  id: string;
  building_id: string;
  label: string;
  floor: number | null;
  access_notes: string | null;
}

interface AssetRow {
  id: string;
  building_id: string;
  unit_id: string | null;
  kind: AssetKind;
  label: string | null;
  notes: string | null;
}

const buildingColumns = 'id, name, city, street, house_number, access_notes';
const unitColumns = 'id, building_id, label, floor, access_notes';
const assetColumns = 'id, building_id, unit_id, kind, label, notes';

export function createPortfolio(deps: PortfolioDeps): Portfolio {
  const { pool } = deps;
  const clock = deps.clock ?? systemClock;
  const audit = deps.audit ?? createAuditLog(pool, clock);

  async function requireBuilding(buildingId: string): Promise<void> {
    const found = await pool.query(
      'SELECT 1 FROM portfolio_buildings WHERE id = $1',
      [buildingId],
    );
    if (found.rowCount === 0) {
      throw new KernelError('not_found', 'building not found');
    }
  }

  return {
    async addBuilding(input, actor) {
      // The subject is unknown until the work runs — on a repeat the caller gets
      // the existing building, whose id is not the one this call would mint.
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'portfolio.addBuilding',
          inputs: {
            name: asText(input?.name),
            city: asText(input?.city),
            street: asText(input?.street),
            houseNumber: asText(input?.houseNumber),
          },
        },
        async () => {
          const name = requireText(input?.name, 'name', maxName);
          const city = requireText(input?.city, 'city', maxName);
          const street = requireText(input?.street, 'street', maxName);
          const houseNumber = requireText(
            input?.houseNumber,
            'houseNumber',
            maxLabel,
          );
          const accessNotes = optionalText(
            input?.accessNotes,
            'accessNotes',
            maxNotes,
          );
          const key = addressKey({ city, street, houseNumber });

          // A building *is* its address: the unique index is the idempotency,
          // so this module needs no caller-supplied intent keys at all.
          const inserted = await pool.query<BuildingRow>(
            `INSERT INTO portfolio_buildings
               (id, name, city, street, house_number, address_key, access_notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (address_key) DO NOTHING
             RETURNING ${buildingColumns}`,
            [
              newId(clock),
              name,
              city,
              street,
              houseNumber,
              key,
              accessNotes,
              clock.now(),
            ],
          );
          const row =
            inserted.rows[0] ??
            (
              await pool.query<BuildingRow>(
                `SELECT ${buildingColumns} FROM portfolio_buildings WHERE address_key = $1`,
                [key],
              )
            ).rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'building could not be read');
          }
          return toBuilding(row, false);
        },
      );
    },

    async addUnit(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'portfolio.addUnit',
          subjectId: asText(input?.buildingId),
          inputs: {
            buildingId: asText(input?.buildingId),
            label: asText(input?.label),
            floor: input?.floor ?? null,
          },
        },
        async () => {
          const buildingId = validId(input?.buildingId, 'buildingId');
          const label = requireText(input?.label, 'label', maxLabel);
          const key = unitKey(label);
          const floor = optionalFloor(input?.floor);
          const accessNotes = optionalText(
            input?.accessNotes,
            'accessNotes',
            maxNotes,
          );

          await requireBuilding(buildingId);

          const inserted = await pool.query<UnitRow>(
            `INSERT INTO portfolio_units
               (id, building_id, label, label_key, floor, access_notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (building_id, label_key) DO NOTHING
             RETURNING ${unitColumns}`,
            [
              newId(clock),
              buildingId,
              label,
              key,
              floor,
              accessNotes,
              clock.now(),
            ],
          );
          const row =
            inserted.rows[0] ??
            (
              await pool.query<UnitRow>(
                `SELECT ${unitColumns} FROM portfolio_units
                  WHERE building_id = $1 AND label_key = $2`,
                [buildingId, key],
              )
            ).rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'unit could not be read');
          }
          return toUnit(row, false);
        },
      );
    },

    async addAsset(input, actor) {
      return audit.around(
        {
          actorKind: actor.kind,
          actorId: actor.id,
          action: 'portfolio.addAsset',
          subjectId: asText(input?.buildingId),
          inputs: {
            buildingId: asText(input?.buildingId),
            unitId: asText(input?.unitId),
            kind: input?.kind,
            label: asText(input?.label),
          },
        },
        async () => {
          const buildingId = validId(input?.buildingId, 'buildingId');
          const kind = validKind(input?.kind);
          const label = optionalText(input?.label, 'label', maxName);
          const notes = optionalText(input?.notes, 'notes', maxNotes);
          const unitId =
            input?.unitId === undefined || input?.unitId === null
              ? null
              : validId(input.unitId, 'unitId');

          await requireBuilding(buildingId);
          if (unitId !== null) {
            const unit = await pool.query<{ building_id: string }>(
              'SELECT building_id FROM portfolio_units WHERE id = $1',
              [unitId],
            );
            const owner = unit.rows[0];
            if (!owner) {
              throw new KernelError('not_found', 'unit not found');
            }
            // The composite foreign key makes this impossible; checking here
            // makes it a sentence instead of a driver error.
            if (owner.building_id !== buildingId) {
              throw new KernelError('invalid', 'unit is not in that building');
            }
          }

          const inserted = await pool.query<AssetRow>(
            `INSERT INTO portfolio_assets
               (id, building_id, unit_id, kind, label, notes, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (building_id, unit_id, kind, label) DO NOTHING
             RETURNING ${assetColumns}`,
            [newId(clock), buildingId, unitId, kind, label, notes, clock.now()],
          );
          const row =
            inserted.rows[0] ??
            (
              await pool.query<AssetRow>(
                `SELECT ${assetColumns} FROM portfolio_assets
                  WHERE building_id = $1
                    AND unit_id IS NOT DISTINCT FROM $2
                    AND kind = $3
                    AND label IS NOT DISTINCT FROM $4`,
                [buildingId, unitId, kind, label],
              )
            ).rows[0];
          if (!row) {
            throw new KernelError('unavailable', 'asset could not be read');
          }
          return {
            id: row.id,
            buildingId: row.building_id,
            unitId: row.unit_id,
            kind: row.kind,
            label: row.label,
            notes: row.notes,
          };
        },
      );
    },

    async getUnit(unitId, options = {}) {
      const id = validId(unitId, 'unitId');
      const withNotes = options.includeAccessNotes === true;

      // The whole tree in one query: the unit, its building, and the assets of
      // both — a unit asset and a building asset are equally in scope for
      // whoever is looking at this unit.
      const found = await pool.query<
        UnitRow & {
          b_id: string;
          b_name: string;
          b_city: string;
          b_street: string;
          b_house_number: string;
          b_access_notes: string | null;
          assets: Array<{
            id: string;
            kind: AssetKind;
            label: string | null;
            notes: string | null;
            scope: 'unit' | 'building';
          }>;
        }
      >(
        `SELECT u.id, u.building_id, u.label, u.floor, u.access_notes,
                b.id AS b_id, b.name AS b_name, b.city AS b_city,
                b.street AS b_street, b.house_number AS b_house_number,
                b.access_notes AS b_access_notes,
                coalesce(
                  json_agg(
                    json_build_object(
                      'id', a.id, 'kind', a.kind, 'label', a.label,
                      'notes', a.notes,
                      'scope', CASE WHEN a.unit_id IS NULL THEN 'building' ELSE 'unit' END
                    )
                    ORDER BY (a.unit_id IS NULL), a.kind, a.label
                  ) FILTER (WHERE a.id IS NOT NULL),
                  '[]'
                ) AS assets
           FROM portfolio_units u
           JOIN portfolio_buildings b ON b.id = u.building_id
           LEFT JOIN portfolio_assets a
             ON a.building_id = u.building_id
            AND (a.unit_id = u.id OR a.unit_id IS NULL)
          WHERE u.id = $1
          GROUP BY u.id, b.id`,
        [id],
      );
      const row = found.rows[0];
      // An id must have been issued by something, so a miss is a dangling
      // reference — unlike identity.findByPhone, where null is a real answer.
      if (!row) {
        throw new KernelError('not_found', 'unit not found');
      }
      return {
        unit: toUnit(row, withNotes),
        building: toBuilding(
          {
            id: row.b_id,
            name: row.b_name,
            city: row.b_city,
            street: row.b_street,
            house_number: row.b_house_number,
            access_notes: row.b_access_notes,
          },
          withNotes,
        ),
        assets: row.assets,
      };
    },
  };
}

// Access notes are opt-in: they are entry codes, and a caller must ask for them
// rather than remember to strip them.
function toBuilding(row: BuildingRow, withNotes: boolean): Building {
  const building: Building = {
    id: row.id,
    name: row.name,
    city: row.city,
    street: row.street,
    houseNumber: row.house_number,
  };
  return withNotes ? { ...building, accessNotes: row.access_notes } : building;
}

function toUnit(row: UnitRow, withNotes: boolean): Unit {
  const unit: Unit = {
    id: row.id,
    buildingId: row.building_id,
    label: row.label,
    floor: row.floor,
  };
  return withNotes ? { ...unit, accessNotes: row.access_notes } : unit;
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new KernelError('invalid', `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw new KernelError('invalid', `${field} must be 1 to ${max} characters`);
  }
  return trimmed;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, field, max);
}

function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new KernelError('invalid', `${field} is not an id`);
  }
  return value;
}

function optionalFloor(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !Number.isInteger(value) ||
    (value as number) < minFloor ||
    (value as number) > maxFloor
  ) {
    throw new KernelError('invalid', 'floor is not a floor');
  }
  return value as number;
}

function validKind(value: unknown): AssetKind {
  if (!assetKinds.includes(value as AssetKind)) {
    throw new KernelError('invalid', 'unknown asset kind', { kind: value });
  }
  return value as AssetKind;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
