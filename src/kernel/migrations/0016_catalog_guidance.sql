-- catalog: the office's own policy text, retrievable and citable. Described in
-- SPEC-catalog.md, "Guidance documents". The kernel runs this migration and
-- never reads it.

-- No DEFAULT now() on created_at, as in 0004 through 0015: time in SQL comes
-- from the injected clock (SPEC-kernel.md decision 3).

-- **There is no tenancy_id in this file, and that is the design.** A lease
-- belongs to one tenancy; a policy belongs to the company. Putting policy text
-- in occupancy_document_chunks would mean a nullable tenancy_id, which is the
-- exact shape SPEC-occupancy.md's "the filter is a column" forbids: once the
-- column can be null, every retrieval query is either blind to policy or is
-- rewritten as `IS NULL OR = $1`, and the second form is one keystroke from
-- answering one tenant with another's lease. Here the isolation rule is honoured
-- by the column not existing.
CREATE TABLE IF NOT EXISTS catalog_guidance_documents (
  id uuid PRIMARY KEY,
  -- The file's identity across syncs: `docs/guidance/office-hours.md` is always
  -- the same document, however its title is edited.
  slug text NOT NULL UNIQUE CHECK (length(slug) > 0),
  title text NOT NULL CHECK (length(title) > 0),
  source_path text NOT NULL,
  -- What the file said last time it was read. A sync that finds the same
  -- checksum re-embeds nothing: identical text produces identical vectors, and
  -- paying a provider to confirm that is the reason `npm run guidance` would
  -- otherwise be expensive to run often.
  checksum text NOT NULL,
  ingested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_guidance_chunks (
  id uuid PRIMARY KEY,
  -- CASCADE, unlike occupancy's chunk, which is RESTRICT. The difference is
  -- what the parent is: an occupancy document points at a real uploaded object
  -- and a dangling reference to one must be impossible. A guidance document's
  -- source of truth is a file in git, so its rows carry nothing that cannot be
  -- rebuilt by running the sync again.
  document_id uuid NOT NULL
    REFERENCES catalog_guidance_documents (id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  -- What a citation says: `נוהל פנייה למשרד § שעות פעילות`. NOT NULL, unlike
  -- occupancy's clause_ref -- a real lease has a cover page with no clause
  -- number, and markdown we write ourselves has no such thing. Everything before
  -- the first heading is cited by the document's title.
  heading_ref text NOT NULL CHECK (length(heading_ref) > 0),
  -- The section's own heading, or NULL for the text above the first one.
  heading text,
  text text NOT NULL CHECK (length(text) > 0),
  created_at timestamptz NOT NULL,
  -- The natural key that makes a re-sync a replacement rather than a copy.
  UNIQUE (document_id, ordinal)
);

CREATE TABLE IF NOT EXISTS catalog_guidance_embeddings (
  chunk_id uuid NOT NULL
    REFERENCES catalog_guidance_chunks (id) ON DELETE CASCADE,
  -- In the key for the reason occupancy's is: re-embedding under a new model
  -- must not rewrite the text, and both sets have to exist while a change is in
  -- flight.
  model text NOT NULL,
  embedding vector(1536) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

-- Cosine, matching how the vectors are compared in the query, and hnsw for the
-- reason 0012 chose it: no training step, and no degradation on a corpus of a
-- few policy documents.
CREATE INDEX IF NOT EXISTS catalog_guidance_embeddings_vector
  ON catalog_guidance_embeddings USING hnsw (embedding vector_cosine_ops);
