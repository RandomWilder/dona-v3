-- occupancy: the join between a person and a place. Described in
-- SPEC-occupancy.md. The kernel runs this migration and never reads these
-- tables.

-- No DEFAULT now() on created_at, as in 0004 and 0005: time in SQL comes from
-- the injected clock (SPEC-kernel.md decision 3).

-- The foreign keys below cross into portfolio and identity deliberately.
-- AGENTS.md's boundary rule governs *code* imports — no module reaches past
-- another's contract.ts, and this one does not. SPEC.md's module map already
-- declares occupancy depends on both, so the direction is legal and there is no
-- cycle. This is the one place the join exists, so its referential integrity is
-- Postgres's job — the same argument that made identity_phones.phone a primary
-- key rather than an indexed column.
CREATE TABLE IF NOT EXISTS occupancy_tenancies (
  id uuid PRIMARY KEY,
  unit_id uuid NOT NULL
    REFERENCES portfolio_units (id) ON DELETE RESTRICT,
  starts_on date NOT NULL,
  -- NULL is open-ended. A value is the end of the term *currently in force*,
  -- not the lease's ultimate expiry: the term is an initial period plus two
  -- options capped at ten years, so exercising an option updates this column.
  ends_on date,
  -- On the tenancy and not on the unit: the landlord may reassign a bay,
  -- temporarily or permanently, and that is a change to the tenancy rather than
  -- to the building.
  parking_spot text,
  storage_unit text,
  created_at timestamptz NOT NULL,
  -- The natural key: one tenancy of one unit beginning on one date. This is
  -- what makes a re-run of day 8's importer a no-op rather than a duplicate,
  -- so no caller-supplied intent key is needed anywhere in this module.
  UNIQUE (unit_id, starts_on),
  CONSTRAINT occupancy_tenancies_term
    CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

-- The role is on the link, not on the person. The lease has three kinds of
-- party: two tenants jointly and severally, and a guarantor who signs the
-- שטר חוב and does not live there. On the person, `tenant` would be true
-- system-wide; on the link, one man can guarantee his daughter's flat while
-- renting his own.
--
-- A person holds one row per role — someone who lives there and also pays holds
-- `tenant` and `billed`, the same shape as identity_person_kinds.
CREATE TABLE IF NOT EXISTS occupancy_parties (
  tenancy_id uuid NOT NULL
    REFERENCES occupancy_tenancies (id) ON DELETE RESTRICT,
  person_id uuid NOT NULL
    REFERENCES identity_people (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('tenant', 'billed', 'guarantor')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenancy_id, person_id, role)
);

-- resolveByPhone enters from this side: a phone gives a person, and the person
-- is what this index is for.
CREATE INDEX IF NOT EXISTS occupancy_parties_person
  ON occupancy_parties (person_id);

CREATE INDEX IF NOT EXISTS occupancy_tenancies_unit
  ON occupancy_tenancies (unit_id);
