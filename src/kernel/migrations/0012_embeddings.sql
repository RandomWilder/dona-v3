-- occupancy: the vectors its clauses are found by, and the kernel's first
-- config rows. Described in SPEC-occupancy.md ("Retrieval") and SPEC-kernel.md
-- ("Settings", "Embeddings").

-- Safe here rather than a gamble: infra/db-capabilities.sh measured staging on
-- 2026-08-26 and found `vector` 0.8.5 already installed, with the runtime user
-- a member of cloudsqlsuperuser and so entitled to install it anyway. Local and
-- CI both run pgvector/pgvector:pg16. A migration that needed a permission the
-- app lacks would fail at boot, which is a deployed revision that will not
-- start -- so the permission was checked before this line was written.
CREATE EXTENSION IF NOT EXISTS vector;

-- The kernel's settings. SPEC.md rule 4 -- policies are data -- and until this
-- slice nothing in the system had a tunable. jsonb rather than text so a value
-- keeps its type: 1536 comes back a number, not a string that has to be parsed
-- by every reader.
CREATE TABLE IF NOT EXISTS config_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

-- The model id and the width it is requested at. Seeded rather than defaulted
-- in code, because a default in code is the constant rule 4 forbids. `now()` is
-- the one place it is allowed: this is a seed running inside the migration, not
-- a domain write, and there is no injected clock at migration time.
INSERT INTO config_settings (key, value, updated_at) VALUES
  ('embedding.model', '"text-embedding-3-large"', now()),
  ('embedding.dimensions', '1536', now())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS occupancy_chunk_embeddings (
  -- The only CASCADE in this module, and deliberate: an embedding is derived
  -- from a clause and is meaningless without it. Everything else here is
  -- RESTRICT because a dangling reference must be impossible; this is the
  -- opposite case, where the dependent row has no life of its own.
  chunk_id uuid NOT NULL
    REFERENCES occupancy_document_chunks (id) ON DELETE CASCADE,
  -- Carried from the chunk for the reason the chunk carries it: every retrieval
  -- query filters by occupancy, and a filter on a column of the table being
  -- searched is one a query cannot be written without noticing.
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  -- In the key, so re-embedding under a new model does not rewrite the clause
  -- rows and both sets can exist while a change is in flight.
  model text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

-- Cosine, matching how the vectors are compared in the query. hnsw rather than
-- ivfflat: no training step, and it does not degrade when the corpus is one
-- lease. At this size the planner may well prefer a scan, and that is fine --
-- the index is for the shape of the data in month three, not week three.
CREATE INDEX IF NOT EXISTS occupancy_chunk_embeddings_vector
  ON occupancy_chunk_embeddings USING hnsw (embedding vector_cosine_ops);

-- The isolation filter's own index. Every search enters here.
CREATE INDEX IF NOT EXISTS occupancy_chunk_embeddings_tenancy
  ON occupancy_chunk_embeddings (tenancy_id);
