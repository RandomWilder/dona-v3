import { Pool } from 'pg';

export function createPool(
  env: Record<string, string | undefined> = process.env,
): Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    // Kernel error shape { code, message } — formalized as a type in slice 2.2.
    throw Object.assign(new Error('DATABASE_URL is required'), {
      code: 'invalid',
    });
  }
  return new Pool({ connectionString, allowExitOnIdle: true });
}
