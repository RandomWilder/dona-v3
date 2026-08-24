// The occupancy module's public surface. Nothing outside this module reaches
// past this file — internals live under `internal/`. See SPEC-occupancy.md.

export type { OccupancyRole, TenancyAccess } from './internal/roles.ts';
export { occupancyRoles, tenancyAccess } from './internal/roles.ts';
export type {
  Actor,
  AddPartyInput,
  EndTenancyInput,
  Occupancy,
  OccupancyDeps,
  OccupancyResolution,
  OpenTenancyInput,
  Party,
  ResolvedTenancy,
  Tenancy,
  TenancyParty,
  TenancyView,
} from './internal/tenancies.ts';
export { createOccupancy } from './internal/tenancies.ts';
