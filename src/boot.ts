import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createPool } from './kernel/db.ts';
import { migrate } from './kernel/migrate.ts';

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

export interface BootOptions {
  host: string;
  port: number;
}

export async function startServer(options: BootOptions): Promise<string> {
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version: string;
  };
  const pool = createPool();
  await waitForDatabase(pool);
  // Migrations run at boot, so a deploy is also a migration. Concurrent
  // instances are safe: migrate() takes a Postgres advisory lock.
  await migrate(pool);
  const app = buildApp({ pool, version });
  await app.listen({ port: options.port, host: options.host });
  return `dona-v3 ${version} listening on ${options.host}:${options.port}`;
}

// First `docker compose up` — and a cold Cloud SQL instance — need a few
// seconds before Postgres accepts connections.
async function waitForDatabase(pool: Pool): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
