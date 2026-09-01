import { migratedPoolOrNull } from '../src/kernel/pg-support.ts';
import { buildCorpus, embeddingsConfigured } from './corpus.ts';
import { formatReport, loadCases, runCases } from './runner.ts';
import { placeholderSubject } from './subject.ts';

// CI entry point (`npm run evals`). Non-zero exit blocks the merge, exactly
// like a failing test — PIPELINE.md §5.

const cases = await loadCases();
const wantsRetrieval = cases.some((golden) => golden.retrieval);

const keyed = embeddingsConfigured();

// The same argument REQUIRE_POSTGRES makes, for the other half of what a
// retrieval case needs. Without a key the retrieval cases skip, which is right
// on a clean clone and a lie in CI: the gate would pass by grading nothing.
//
// Checked before the pool is opened, so the loud exit does not leave one behind.
if (wantsRetrieval && !keyed && process.env.REQUIRE_EMBEDDINGS === '1') {
  console.error(
    'REQUIRE_EMBEDDINGS=1 but OPENAI_API_KEY is not set — ' +
      'the retrieval cases would have been skipped, not passed.',
  );
  process.exit(1);
}

// REQUIRE_POSTGRES is honoured inside this call, as the durability suite's is:
// no database locally means skip, and `=1` means fail.
const pool = wantsRetrieval && keyed ? await migratedPoolOrNull() : null;
const corpus = pool ? await buildCorpus(pool) : null;
if (corpus) {
  console.log(
    `corpus: ${corpus.chunks} chunks indexed for tenancy ${corpus.tenancyId}`,
  );
}

const report = await runCases(cases, {
  answer: placeholderSubject,
  retrieve: corpus?.retrieve,
});
console.log(formatReport(report));
await pool?.end();
if (report.failed > 0) process.exitCode = 1;
