import type { Pool } from 'pg';
import { resolveEmbedder } from '../src/boot.ts';
import { newId } from '../src/kernel/ids.ts';
import { createMemoryStore } from '../src/kernel/objects.ts';
import type { PdfText } from '../src/kernel/pdf.ts';
import { type Actor, createOccupancy } from '../src/occupancy/contract.ts';
import { createPortfolio } from '../src/portfolio/contract.ts';
import type { CaseInput, RankedHit, Retriever } from './case.ts';
import { mockLeasePages } from './fixtures/mock-lease.ts';

// The corpus a retrieval case is graded against: one tenancy, one indexed
// lease, reached through the same commands an operator's screen uses.
//
// Everything below pdfjs is the real path — attachDocument, ingestDocument,
// chunkLease, the real embedder, real pgvector, searchClauses. Only two seams
// are faked, and neither touches ranking: the object store is in memory (no
// bucket, no credential) and the PDF reader hands back the authored pages
// instead of decoding bytes, because Hebrew through pdfjs needs an embedded
// font and this fixture is about what the *chunker and the embedder* do with
// Hebrew, not about character decoding.

const actor: Actor = { kind: 'staff', id: 'golden-set' };

export interface Corpus {
  tenancyId: string;
  documentId: string;
  chunks: number;
  retrieve: Retriever;
  /** Every hit for a question, for the measurement rather than the gate. */
  search(question: string): Promise<RankedHit[]>;
}

/** True when a real embedder can be built — a key is present. */
export function embeddingsConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.OPENAI_API_KEY?.trim().length ?? 0) > 0;
}

// A reader that hands back the pages the fixture wrote, as
// src/occupancy/contract.test.ts does.
const fixturePdf: PdfText = {
  pages: async () => mockLeasePages,
  describe: () => 'golden-set fixture',
};

export async function buildCorpus(pool: Pool): Promise<Corpus> {
  // Through boot's own resolver rather than a second construction: the model id
  // and its width come from config rows (SPEC.md rule 4), and the golden set
  // must embed under exactly the model the running system embeds under — a
  // ranking measured against a different model measures a different system.
  const embedder = await resolveEmbedder(process.env, pool);

  // Portfolio is built here rather than left to occupancy's own default,
  // because this file needs to call it directly to place the building the lease
  // hangs off — and two constructions would be two audit writers on one pool.
  const portfolio = createPortfolio({ pool });
  const occupancy = createOccupancy({
    pool,
    portfolio,
    store: createMemoryStore(),
    pdf: fixturePdf,
    embedder,
  });

  // Invented fresh per run, as every contract test does: the database persists
  // between runs, so a fixed address would collide with itself. The residue is
  // the same residue the test suite leaves and clears the same way
  // (`npm run reset`); CI's database dies with the job.
  const suffix = newId();
  const building = await portfolio.addBuilding(
    {
      name: 'מעונות הדר',
      city: 'תל אביב',
      street: `ארלוזורוב ${suffix}`,
      houseNumber: '45',
    },
    actor,
  );
  const unit = await portfolio.addUnit(
    { buildingId: building.id, label: '24', floor: 2 },
    actor,
  );
  const tenancy = await occupancy.openTenancy(
    { unitId: unit.id, startsOn: '2026-03-01', endsOn: '2029-02-28' },
    actor,
  );
  const document = await occupancy.attachDocument(
    {
      tenancyId: tenancy.id,
      kind: 'lease',
      contentType: 'application/pdf',
      // Ignored by `fixturePdf`, and still a real PDF header: a byte string
      // that is not one would pass here and fail the day this fixture is
      // pointed at the real reader.
      bytes: Buffer.from('%PDF-1.7\nthe golden-set lease\n%%EOF'),
    },
    actor,
  );

  const ingestion = await occupancy.ingestDocument(
    { documentId: document.id },
    actor,
  );

  async function search(question: string): Promise<RankedHit[]> {
    // The default limit, deliberately: 12.2 measured "5th of 8" and "3rd of 8"
    // against it, and a wider window would make today's ranks look better
    // without anything having improved.
    const hits = await occupancy.searchClauses({
      tenancyId: tenancy.id,
      query: question,
    });
    return hits.map((hit) => ({
      clauseRef: hit.clauseRef,
      distance: hit.distance,
    }));
  }

  return {
    tenancyId: tenancy.id,
    documentId: document.id,
    chunks: ingestion.chunks,
    search,
    retrieve: (input: CaseInput) => search(input.message),
  };
}
