-- portfolio: buildings, the units in them, and the equipment that breaks.
-- Described in SPEC-portfolio.md. The kernel runs this migration and never reads
-- these tables.

-- address_key is the natural key: a building *is* its address, so there are no
-- caller-supplied intent keys anywhere in this module. Normalisation is naive on
-- purpose (SPEC-portfolio.md) — a wrong guess merges two real buildings.
CREATE TABLE IF NOT EXISTS portfolio_buildings (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL,
  street text NOT NULL,
  house_number text NOT NULL, -- text, not a number: 12א is an address
  address_key text NOT NULL UNIQUE,
  access_notes text, -- entry codes; opt-in on the read, never tenant-facing
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS portfolio_units (
  id uuid PRIMARY KEY,
  building_id uuid NOT NULL
    REFERENCES portfolio_buildings (id) ON DELETE RESTRICT,
  label text NOT NULL,
  label_key text NOT NULL,
  floor integer,
  access_notes text,
  created_at timestamptz NOT NULL,
  UNIQUE (building_id, label_key),
  -- Redundant against the primary key, and required: it is the target of the
  -- composite foreign key on portfolio_assets below.
  UNIQUE (id, building_id)
);

-- An asset always names its building; naming a unit as well makes it that
-- unit's. unit_id IS NULL is a building asset — a lift, a gate, the intercom.
CREATE TABLE IF NOT EXISTS portfolio_assets (
  id uuid PRIMARY KEY,
  building_id uuid NOT NULL
    REFERENCES portfolio_buildings (id) ON DELETE RESTRICT,
  unit_id uuid,
  kind text NOT NULL CHECK (
    kind IN (
      'boiler', 'solar_heater', 'air_conditioner', 'lift', 'intercom',
      'gate', 'water_pump', 'electrical_panel', 'other'
    )
  ),
  label text,
  notes text,
  created_at timestamptz NOT NULL,
  -- One key, not two: an asset cannot name unit 3 of one building and the
  -- address of another.
  FOREIGN KEY (unit_id, building_id)
    REFERENCES portfolio_units (id, building_id) ON DELETE RESTRICT,
  -- NULLS NOT DISTINCT (PostgreSQL 15+) is what makes two building assets of
  -- the same kind collide instead of duplicating, since their unit_id is NULL.
  UNIQUE NULLS NOT DISTINCT (building_id, unit_id, kind, label)
);

CREATE INDEX IF NOT EXISTS portfolio_assets_unit
  ON portfolio_assets (unit_id);

CREATE INDEX IF NOT EXISTS portfolio_units_building
  ON portfolio_units (building_id);
