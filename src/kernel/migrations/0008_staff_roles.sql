-- staff: admin / operator / viewer. Described in SPEC-staff.md. The kernel runs
-- this migration and never reads this table.

ALTER TABLE staff_operators ADD COLUMN IF NOT EXISTS role text;

-- Every operator that already exists becomes an admin. The seeded account on
-- staging and prod is reachable no other way: the seeder creates but never
-- updates, so a migration is the only thing that can touch a row already there.
UPDATE staff_operators SET role = 'admin' WHERE role IS NULL;

-- No DEFAULT, as in 0004-0006: an insert names a role rather than inheriting a
-- lucky one, so a future caller that forgets fails loudly instead of quietly
-- minting whatever the default happened to be.
ALTER TABLE staff_operators ALTER COLUMN role SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE staff_operators
    ADD CONSTRAINT staff_operators_role_check
    CHECK (role IN ('admin', 'operator', 'viewer'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
