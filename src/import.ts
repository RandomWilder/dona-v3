import { readFileSync } from 'node:fs';
import { importTenants } from './import/contract.ts';
import { createPool } from './kernel/db.ts';
import { toErrorBody } from './kernel/errors.ts';
import { migrate } from './kernel/migrate.ts';

// The tenant mapping importer. Dry run by default: the first run against real
// tenant data should be readable before it is irreversible.
//
//   npm run import -- <file.csv>            reports what would land
//   npm run import -- <file.csv> --commit   writes it
const args = process.argv.slice(2);
const commit = args.includes('--commit');
const file = args.find((arg) => !arg.startsWith('--'));

if (!file) {
  console.error('usage: npm run import -- <file.csv> [--commit]');
  process.exit(2);
}

const pool = createPool();
try {
  await migrate(pool);
  const report = await importTenants(
    readFileSync(file, 'utf8'),
    { pool },
    {
      commit,
    },
  );

  console.log(commit ? 'COMMITTED' : 'DRY RUN — nothing was written');
  console.log(
    `read ${report.read} · ${commit ? 'applied' : 'would apply'} ${report.applied} · rejected ${report.rejected.length}`,
  );
  for (const rejection of report.rejected) {
    console.log(
      `  line ${rejection.line}: ${rejection.code} — ${rejection.reason}`,
    );
  }
  // Non-zero when anything was rejected, so this is usable from a script.
  process.exit(report.rejected.length > 0 ? 1 : 0);
} catch (error) {
  const body = toErrorBody(error);
  console.error(`import failed: ${body.code} — ${body.message}`);
  process.exit(2);
} finally {
  await pool.end();
}
