import type { Pool } from 'pg';
import { createStaffAuth } from './internal/auth.ts';
import {
  type SeedEnv,
  type SeedResult,
  seedStaffOperator,
} from './internal/seed.ts';

// The staff module's public surface. Nothing outside this module reaches past
// this file — internals live under `internal/`.
export type { StaffDeps } from './ui/routes.ts';
export { registerStaffUi } from './ui/routes.ts';
export type { SeedEnv, SeedResult };

export function seedStaff(pool: Pool, env: SeedEnv): Promise<SeedResult> {
  return seedStaffOperator(createStaffAuth(pool), env);
}
