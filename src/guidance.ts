import { resolveEmbedder } from './boot.ts';
import {
  createCatalog,
  createDirectorySource,
  guidanceDir,
} from './catalog/contract.ts';
import { createPool } from './kernel/db.ts';
import { toErrorBody } from './kernel/errors.ts';
import { migrate } from './kernel/migrate.ts';

// Loads `docs/guidance/*.md` into the catalog, so an off-lease question has
// something to be answered from.
//
//   npm run guidance
//
// A deliberate, human-run step rather than something boot does. A deploy that
// depended on a call to a model provider would be a deploy that fails when the
// provider is slow -- and the files are in git either way, so nothing is lost by
// loading them a minute later. Reaching staging's database from a laptop is the
// tunnel in docs/runbook-deploy.md, exactly as a reset is.
//
// Safe to run as often as anyone likes: a file whose bytes have not changed is
// skipped without being embedded again.

const pool = createPool();
try {
  await migrate(pool);
  const embedder = await resolveEmbedder(process.env, pool);
  const catalog = createCatalog({
    pool,
    embedder,
    source: createDirectorySource(),
  });
  const report = await catalog.syncGuidance({ kind: 'system' });
  console.log(
    `guidance: ${report.documents} read · ${report.chunks} sections · ` +
      `${report.skipped} unchanged · ${report.model} · ${guidanceDir}`,
  );
  for (const document of await catalog.listGuidance()) {
    console.log(
      `  ${document.title} — ${document.chunks} sections (${document.sourcePath})`,
    );
  }
  process.exit(0);
} catch (error) {
  const body = toErrorBody(error);
  console.error(`guidance sync failed: ${body.code} — ${body.message}`);
  process.exit(2);
} finally {
  await pool.end();
}
