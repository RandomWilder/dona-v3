import { Pool } from 'pg';
import { KernelError } from './errors.ts';

export function createPool(
  env: Record<string, string | undefined> = process.env,
): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new KernelError('invalid', 'DATABASE_URL is required');
  }
  return new Pool({ connectionString, allowExitOnIdle: true });
}
