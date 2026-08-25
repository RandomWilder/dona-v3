-- occupancy: the documents a tenancy is made of. Described in
-- SPEC-occupancy.md. The kernel runs this migration and never reads it.

-- No DEFAULT now() on created_at, as in 0004 through 0006: time in SQL comes
-- from the injected clock (SPEC-kernel.md decision 3).

-- The row hangs off the tenancy and not off the unit, which is the whole point
-- of the table: the tenancy is the scope every later read is filtered by, and a
-- document attached to a unit would outlive the tenancy entitled to see it.
CREATE TABLE IF NOT EXISTS occupancy_documents (
  id uuid PRIMARY KEY,
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (
    kind IN ('lease', 'appendix', 'guarantee', 'other')
  ),
  -- The path names the place with ids and carries no personal text at all --
  -- paths reach logs (slice 7.0). UNIQUE so two rows can never claim one
  -- object, and so a retry cannot quietly fork a document's history.
  object_path text NOT NULL UNIQUE,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  created_at timestamptz NOT NULL
);

-- Every read starts from the tenancy: "what documents does this tenancy have".
CREATE INDEX IF NOT EXISTS occupancy_documents_tenancy
  ON occupancy_documents (tenancy_id, created_at DESC);
