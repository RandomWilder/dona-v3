import type { Pool } from 'pg';
import { createStaffAuth } from './internal/auth.ts';
import {
  createStaffCommands,
  type StaffCommandDeps,
  type StaffCommands,
} from './internal/commands.ts';
import {
  type SeedEnv,
  type SeedResult,
  seedStaffOperator,
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
export type { SeedEnv, SeedResult, StaffCommandDeps, StaffCommands };
export { createStaffCommands };

export function seedStaff(pool: Pool, env: SeedEnv): Promise<SeedResult> {
  return seedStaffOperator(createStaffAuth(pool), env);
}
