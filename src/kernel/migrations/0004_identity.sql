-- identity: people, the numbers that reach them, and what kind of person each is.
-- Described in SPEC-identity.md. The kernel runs this migration and never reads
-- these tables.

-- No DEFAULT now() on created_at anywhere here: time in SQL comes from the
-- injected clock (SPEC-kernel.md decision 3), and a column default would be a
-- second source of truth that no test can see.
CREATE TABLE IF NOT EXISTS identity_people (
  id uuid PRIMARY KEY,
  display_name text NOT NULL, -- pii
  language text NOT NULL DEFAULT 'he' CHECK (language IN ('he', 'en')),
  created_at timestamptz NOT NULL
);

-- The phone is the primary key, not a column with an index: one number belongs
-- to exactly one person, system-wide. Every read in weeks 3-5 is scoped by what
-- this resolves to, so the uniqueness is Postgres's job rather than the
-- caller's.
CREATE TABLE IF NOT EXISTS identity_phones (
  phone text PRIMARY KEY, -- pii, E.164, normalised on the way in
  person_id uuid NOT NULL REFERENCES identity_people (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS identity_phones_person
  ON identity_phones (person_id);

-- A person may hold more than one kind — the plumber who also rents is one
-- person. `staff` here classifies a human being; it is not a login, which is
-- staff_operators' business.
CREATE TABLE IF NOT EXISTS identity_person_kinds (
  person_id uuid NOT NULL REFERENCES identity_people (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tenant', 'vendor', 'staff')),
  PRIMARY KEY (person_id, kind)
);
