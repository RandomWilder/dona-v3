-- occupancy: the digital twin -- the lease's fields, each pointing at the clause
-- it was read out of. Described in SPEC-occupancy.md, "The digital twin". The
-- kernel runs this migration and never reads it.

-- No DEFAULT now() on extracted_at, as in 0004 through 0012: time in SQL comes
-- from the injected clock (SPEC-kernel.md decision 3). The seed below is the
-- one place now() is allowed -- it runs inside the migration, where there is no
-- injected clock, as 0012's seed does.

-- Which model reads a lease into fields. A config row rather than a constant
-- (SPEC.md rule 4), and read per call rather than at boot, unlike
-- embedding.model: this one is welded to nothing already stored, and a model id
-- the account cannot serve has to be correctable with one row and no deploy.
INSERT INTO config_settings (key, value, updated_at) VALUES
  ('extraction.model', '"gpt-5"', now())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS occupancy_lease_facts (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL
    REFERENCES occupancy_documents (id) ON DELETE RESTRICT,
  -- Duplicated onto the row for the third time in this module, and for the
  -- third time it is the same argument: every read of a tenant's facts filters
  -- by occupancy, and a filter on a column of the table being read is one a
  -- query cannot be written without noticing. Copied from the document at
  -- extraction time and never taken from a caller.
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  -- No CHECK, and the exception is deliberate. Every other closed vocabulary
  -- here is a CHECK -- party roles, document kinds, staff roles -- but this list
  -- is stated to be growing: the five fields week 3 needs are not the five the
  -- product will end with. A CHECK would make each new field a migration whose
  -- entire content is a second copy of a list `internal/twin.ts` already
  -- enforces at the edge, and the two copies would drift.
  field text NOT NULL CHECK (length(field) > 0),
  -- Shaped per field by twin.ts: a term is an initial period plus its options
  -- and a cap, never a single end date; a rent is a base figure with its index,
  -- its base month and the re-basing rule in the lease's words, never a number
  -- this system computed. SPEC.md rule 7 is enforced by a stored shape with
  -- nowhere to put a charge, not by a convention that nobody writes one.
  value jsonb NOT NULL,
  -- What makes a field checkable rather than merely asserted. RESTRICT, so a
  -- clause cannot be deleted out from under the field that cites it -- and
  -- re-ingesting a document deletes its chunks, which is why extraction is
  -- replaced with them rather than left pointing at text that has moved.
  chunk_id uuid NOT NULL
    REFERENCES occupancy_document_chunks (id) ON DELETE RESTRICT,
  -- Copied from the chunk at extraction time so the screen and 13.2's reviewer
  -- can cite without a join. NULL is not expected here -- selection requires a
  -- clause number -- but the column it is copied from is nullable, and a NOT
  -- NULL here would be this table asserting something the source cannot.
  clause_ref text,
  page_from integer NOT NULL CHECK (page_from > 0),
  page_to integer NOT NULL CHECK (page_to >= page_from),
  -- What the model said about itself, named so nothing downstream mistakes it
  -- for a measurement of ours.
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- Which model produced it. Not in the key, unlike the embeddings' model:
  -- there, two models' vectors must coexist while a change is in flight; here a
  -- re-extraction replaces the field, and this column says what read it last.
  model text NOT NULL,
  extracted_at timestamptz NOT NULL,
  -- Derived data with a natural key, as chunks are. Re-extracting one document
  -- is a replacement rather than a second copy.
  UNIQUE (document_id, field)
);

-- The isolation filter's own index, as on the chunks and the embeddings. Every
-- read of a tenant's twin enters by tenancy.
CREATE INDEX IF NOT EXISTS occupancy_lease_facts_tenancy
  ON occupancy_lease_facts (tenancy_id);
