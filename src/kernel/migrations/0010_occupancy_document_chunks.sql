-- occupancy: the clauses a document is cut into. Described in
-- SPEC-occupancy.md, "Lease chunks". The kernel runs this migration and never
-- reads it.

-- No DEFAULT now() on created_at, as in 0004 through 0009: time in SQL comes
-- from the injected clock (SPEC-kernel.md decision 3).

CREATE TABLE IF NOT EXISTS occupancy_document_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL
    REFERENCES occupancy_documents (id) ON DELETE RESTRICT,
  -- Reachable through document_id, and stored anyway. Slice 12.2 filters every
  -- retrieval query by occupancy -- SPEC.md's "absolute tenant isolation
  -- enforced at the query layer" -- and a filter on a column of the table being
  -- searched is one a vector query cannot be written without noticing. A filter
  -- that needs a join back to occupancy_documents is a join a later query can
  -- be written without, and the query that forgets it returns another tenant's
  -- lease. Safe to duplicate because a document never moves between tenancies.
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  -- Reading order within the document. With document_id it is the natural key
  -- that makes re-ingest a replacement rather than a second copy.
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  -- What a citation will say: 'נספח א׳ §3.2', '§14.1'. NULL is honest and not a
  -- gap -- a cover page, a preamble and a signature block have no clause
  -- number, and an invented one is a citation pointing at nothing.
  clause_ref text,
  heading text,
  -- The location a human checks the citation against. A clause running across a
  -- page break is one chunk with two page numbers.
  page_from integer NOT NULL CHECK (page_from > 0),
  page_to integer NOT NULL CHECK (page_to >= page_from),
  text text NOT NULL CHECK (length(text) > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, ordinal)
);

-- The isolation filter's own index: week 3's retrieval enters here, by tenancy,
-- and never by document.
CREATE INDEX IF NOT EXISTS occupancy_document_chunks_tenancy
  ON occupancy_document_chunks (tenancy_id);
