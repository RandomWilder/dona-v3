-- occupancy: the human's answer to the twin -- one row per field a person has
-- confirmed or corrected. Described in SPEC-occupancy.md, "Reviewing a field".
-- The kernel runs this migration and never reads it.

-- No DEFAULT now() on reviewed_at, as in 0004 through 0014: time in SQL comes
-- from the injected clock (SPEC-kernel.md decision 3).

CREATE TABLE IF NOT EXISTS occupancy_lease_field_reviews (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL
    REFERENCES occupancy_documents (id) ON DELETE RESTRICT,
  -- The isolation filter, on the row for the fourth time in this module and for
  -- the fourth time the same argument: every read of a tenant's twin filters by
  -- occupancy, and a filter on a column of the table being read is one a query
  -- cannot be written without noticing. Copied from the document inside the
  -- command and never taken from a caller.
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  -- No CHECK, for the reason 0013 gives: the vocabulary of lease fields is
  -- stated to be growing, and a constraint here would make each new field a
  -- migration whose entire content copies a list `internal/twin.ts` enforces.
  field text NOT NULL CHECK (length(field) > 0),
  -- This one *is* a CHECK, and the difference is the point. A field name is a
  -- list that grows; the two things a human can say about a value are not.
  decision text NOT NULL CHECK (decision IN ('confirmed', 'corrected')),
  -- The value the human stands behind. For a confirmation it is a copy of what
  -- the extraction produced; for a correction it is that value with their edits
  -- applied and their dropped rows removed. Where the review stands, this is the
  -- value of record and the fact is the working that produced it.
  value jsonb NOT NULL,
  -- What the review was a statement *about*: the extracted value at the moment
  -- it was made. This column is the whole mechanism of the slice. 13.1 required
  -- that a re-extraction producing a different value must not leave the old
  -- confirmation standing beside the new number, and comparing this against the
  -- document's current fact is how that is answered -- without deleting the
  -- review, which would throw away the evidence that the value used to differ.
  reviewed_value jsonb NOT NULL,
  -- Who, in the shape audit_log uses for an actor: a kind and an id, text and
  -- not uuid because an actor id is not always a row in this database. No
  -- foreign key to staff_operators -- occupancy is handed an actor and knows
  -- nothing about the staff module's tables.
  reviewed_by_kind text NOT NULL
    CHECK (reviewed_by_kind IN ('tenant', 'staff', 'agent', 'system')),
  reviewed_by_id text NOT NULL CHECK (length(reviewed_by_id) > 0),
  reviewed_at timestamptz NOT NULL,
  -- One current review per field per document. A second review of the same
  -- field is the same person looking again, not a second opinion to reconcile.
  UNIQUE (document_id, field)
);

-- Deliberately no foreign key to occupancy_lease_facts or to
-- occupancy_document_chunks, and this is the one structural decision in the
-- table. Both are derived rows that are deleted and rewritten wholesale every
-- time a document is read again: a RESTRICT would let a review block a
-- re-extraction, and a CASCADE would let a re-extraction erase a human's
-- statement with nothing on screen to show it had existed. A review outlives
-- the extraction it was about, and `reviewed_value` is what keeps it honest
-- when the extraction changes underneath it.

-- The isolation filter's own index, as on the chunks, the embeddings and the
-- facts. Every read of a tenant's twin enters by tenancy.
CREATE INDEX IF NOT EXISTS occupancy_lease_field_reviews_tenancy
  ON occupancy_lease_field_reviews (tenancy_id);
