import type { Pool } from 'pg';
import { createStaffAuth } from './internal/auth.ts';
import {
  createStaffCommands,
  type StaffCommandDeps,
  type StaffCommands,
} from './internal/commands.ts';
import {
  createStaffQueries,
  type PersonDetail,
  type StaffQueries,
  type UnitDetail,
} from './internal/queries.ts';
import {
  type SeedEnv,
  type SeedResult,
  seedStaffOperator,
  seedStaffViewer,
} from './internal/seed.ts';

// Slice 9.1. The role-checked way into the domain modules: slice 10.1's create
// views call these rather than reaching for identity, portfolio or occupancy
// themselves, which is what keeps the permission check on one path.
export type { Operator, Session } from './internal/auth.ts';
export type { Capability, StaffRole } from './internal/roles.ts';
export { capabilities, permits, staffRoles } from './internal/roles.ts';
// The staff module's public surface. Nothing outside this module reaches past
// this file — internals live under `internal/`.
export type { StaffDeps } from './ui/routes.ts';
export { registerStaffUi } from './ui/routes.ts';
export type {
  PersonDetail,
  SeedEnv,
  SeedResult,
  StaffCommandDeps,
  StaffCommands,
  StaffQueries,
  UnitDetail,
};
export { createStaffCommands, createStaffQueries };

export function seedStaff(pool: Pool, env: SeedEnv): Promise<SeedResult> {
  return seedStaffOperator(createStaffAuth(pool), env);
}

// Slice 10.2. Separate from seedStaff and not a flag on it: the two differ in
// what a missing configuration means, and a boolean at this seam would hide
// that. The admin is required; this one is not.
export function seedViewer(pool: Pool, env: SeedEnv): Promise<SeedResult> {
  return seedStaffViewer(createStaffAuth(pool), env);
}
