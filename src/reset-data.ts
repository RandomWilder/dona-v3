import { readFileSync } from 'node:fs';
import { importTenants } from './import/contract.ts';
import { createPool } from './kernel/db.ts';
import { toErrorBody } from './kernel/errors.ts';
import { migrate } from './kernel/migrate.ts';
import {
  assertNotProduction,
  countTables,
  resetDomainData,
} from './reset/contract.ts';

// Empties the domain tables and re-seeds them from a template. Dry run by
// default, like the importer: a command that destroys data should be readable
// before it is irreversible.
//
//   npm run reset -- <file.csv>            reports what it would remove
//   npm run reset -- <file.csv> --commit   removes it, then imports the file
//
// Reaching staging's database from a laptop is infra/reset-staging-data.sh's
// job, not this file's. See docs/runbook-deploy.md.
const args = process.argv.slice(2);
const commit = args.includes('--commit');
const file = args.find((arg) => !arg.startsWith('--'));

if (!file) {
  console.error('usage: npm run reset -- <file.csv> [--commit]');
  process.exit(2);
}

assertNotProduction(process.env.DATABASE_URL ?? '');

const pool = createPool();
try {
  await migrate(pool);

  if (!commit) {
    // The dry run still reads the truncate list, so it reports the real
    // quantity of what is about to go — the number that decides whether the
    // person running this meant it.
    const report = await importTenants(readFileSync(file, 'utf8'), { pool });
    const { removed, preserved } = await countTables(pool);
    console.log('DRY RUN — nothing was written');
    console.log(`  would remove:  ${describe(removed)}`);
    console.log(`  would keep:    ${describe(preserved)}`);
    console.log(
      `  would seed:    ${report.applied} of ${report.read} rows from ${file}`,
    );
    process.exit(report.rejected.length > 0 ? 1 : 0);
  }

  const reset = await resetDomainData(pool);
  console.log(`removed: ${describe(reset.removed)}`);
  console.log(`kept:    ${describe(reset.preserved)}`);

  const report = await importTenants(
    readFileSync(file, 'utf8'),
    { pool },
    { commit: true },
  );
  console.log(
    `seeded ${report.applied} of ${report.read} rows · rejected ${report.rejected.length}`,
  );
  for (const rejection of report.rejected) {
    console.log(
      `  line ${rejection.line}: ${rejection.code} — ${rejection.reason}`,
    );
  }
  process.exit(report.rejected.length > 0 ? 1 : 0);
} catch (error) {
  const body = toErrorBody(error);
  console.error(`reset failed: ${body.code} — ${body.message}`);
  process.exit(2);
} finally {
  await pool.end();
}

// Tables with nothing in them are the majority and say nothing; the ones that
// matter are the ones about to lose rows.
function describe(counts: Record<string, number>): string {
  const named = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`);
  return named.length > 0 ? named.join(' · ') : 'nothing';
}
