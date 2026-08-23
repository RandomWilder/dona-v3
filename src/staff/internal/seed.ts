import { KernelError } from '../../kernel/errors.ts';
import type { StaffAuth } from './auth.ts';

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
export async function seedStaffOperator(
  auth: StaffAuth,
  env: SeedEnv,
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
      'STAFF_SEED_EMAIL and STAFF_SEED_PASSWORD must be set together',
    );
  }

  if (await auth.findByEmail(email)) {
    return { seeded: false, reason: 'already exists' };
  }
  try {
    await auth.createOperator({ email, password });
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
