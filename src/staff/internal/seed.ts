import { KernelError } from '../../kernel/errors.ts';
import type { StaffAuth } from './auth.ts';
import type { StaffRole } from './roles.ts';

export interface SeedEnv {
  email?: string;
  password?: string;
}

export interface SeedResult {
  seeded: boolean;
  reason: 'created' | 'already exists' | 'no seed configured';
}

// Runs on every boot, after migrations and before the server listens. Both
// values come from Secret Manager in staging and prod; the password never
// appears in the repo, in a log, or in an audit record.
//
// Two entry points rather than one function with a role parameter, and neither
// takes the role from the environment. Slice 9.1 rejected a STAFF_SEED_ROLE
// because a value that could say `viewer` is a way to deploy a system with no
// way to administer it; the same objection rules out a defaulted parameter,
// which fails *open* to admin when a caller forgets. Each door below names its
// own role as a literal, so changing who is seeded costs a deploy and leaves a
// diff.

// The first operator, and the one that must exist for the system to be usable.
export function seedStaffOperator(
  auth: StaffAuth,
  env: SeedEnv,
): Promise<SeedResult> {
  return seed(auth, env, 'admin', 'STAFF_SEED');
}

// Slice 10.2. Read-only, and deliberately optional: an environment without it
// is a system with one less demo account, not a system nobody can get into.
export function seedStaffViewer(
  auth: StaffAuth,
  env: SeedEnv,
): Promise<SeedResult> {
  return seed(auth, env, 'viewer', 'STAFF_VIEWER');
}

async function seed(
  auth: StaffAuth,
  env: SeedEnv,
  role: StaffRole,
  varPrefix: string,
): Promise<SeedResult> {
  const email = env.email?.trim();
  const password = env.password;
  if (!email && !password) {
    return { seeded: false, reason: 'no seed configured' };
  }
  // Half a configuration is a mistake, not an intention to skip: failing here
  // is better than a deploy that quietly has no way in.
  if (!email || !password) {
    throw new KernelError(
      'invalid',
      `${varPrefix}_EMAIL and ${varPrefix}_PASSWORD must be set together`,
    );
  }

  if (await auth.findByEmail(email)) {
    return { seeded: false, reason: 'already exists' };
  }
  try {
    await auth.createOperator({ email, password, role });
  } catch (error) {
    // Two instances booting at once both pass the check above; the loser of the
    // insert has still got what it wanted.
    if (error instanceof KernelError && error.code === 'conflict') {
      return { seeded: false, reason: 'already exists' };
    }
    throw error;
  }
  return { seeded: true, reason: 'created' };
}
