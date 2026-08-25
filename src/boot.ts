import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createPool } from './kernel/db.ts';
import { migrate } from './kernel/migrate.ts';
import { seedStaff, seedViewer } from './staff/contract.ts';

const packageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

export interface BootOptions {
  host: string;
  port: number;
}

// What /health reports as `version` is the build's identity, not a semver
// aspiration: the release tag on prod, the commit on staging, and the
// package.json value locally. Falling back to a value that ends in `-dev` is
// deliberate — seeing `-dev` on a deployed URL means the injection did not
// happen, which is exactly what you want to notice.
export function resolveVersion(
  env: Record<string, string | undefined>,
  packageVersion: string,
): string {
  const injected = env.APP_VERSION?.trim();
  return injected ? injected : packageVersion;
}

export async function startServer(options: BootOptions): Promise<string> {
  const { version: packageVersion } = JSON.parse(
    readFileSync(packageJsonPath, 'utf8'),
  ) as {
    version: string;
  };
  const version = resolveVersion(process.env, packageVersion);
  const pool = createPool();
  await waitForDatabase(pool);
  // Migrations run at boot, so a deploy is also a migration. Concurrent
  // instances are safe: migrate() takes a Postgres advisory lock.
  await migrate(pool);
  // Idempotent, and a no-op unless both secrets are present. A deploy that
  // cannot seed must fail here rather than serve a system with no way in.
  const seed = await seedStaff(pool, {
    email: process.env.STAFF_SEED_EMAIL,
    password: process.env.STAFF_SEED_PASSWORD,
  });
  // The read-only account the week-2 demo needs. Optional where the admin is
  // not: absent secrets are a no-op, so local dev and any environment that has
  // not set them boots exactly as before. Half a pair still throws.
  const viewer = await seedViewer(pool, {
    email: process.env.STAFF_VIEWER_EMAIL,
    password: process.env.STAFF_VIEWER_PASSWORD,
  });
  const app = buildApp({ pool, version });
  await app.listen({ port: options.port, host: options.host });
  // Both reported, so a deploy that seeded one and not the other says so on the
  // line an operator actually reads.
  return `dona-v3 ${version} listening on ${options.host}:${options.port} — staff seed: ${seed.reason} · viewer seed: ${viewer.reason}`;
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
