# Evidence — Slice 9.1: admin / operator / viewer

Captured 2026-08-24. GitHub Actions runs age out of the UI; this is the durable record.

Staff logins existed since 5.2, but every operator had the same powers. The bar this
slice had to clear is stated in `tasks/todo.md` and again in ROADMAP week 2: **a viewer
cannot mutate — proven by a test that calls the command directly, not by the UI.**

That bar had a gap under it. `staff` owned no mutating commands at all, so there was
nothing for such a test to call: the mutations live in `identity`, `portfolio` and
`occupancy`. So `staff` gained the guarded surface SPEC.md already says it is — the admin
panel edge, depending on all modules — and the test calls it with a real logged-in
viewer session.

## The acceptance bar

| bar | how it was met |
|---|---|
| a viewer cannot mutate, proven on the command | `refuses a viewer every mutating command, and changes nothing` — all **eight** mutating commands the system has today (`addPerson`, `addPhone`, `addBuilding`, `addUnit`, `addAsset`, `openTenancy`, `addParty`, `endTenancy`), each refused `not_allowed`, with inputs that would have succeeded for any other role |
| refused *before* the module is reached | the same test re-counts, scoped to the ids it aimed at: no person intent key, no building on that street, no new unit, asset, tenancy or party — and the tenancy it tried to end still has `ends_on IS NULL` |
| operator and admin are not blocked | `lets an operator and an admin through the same eight` — the refusal is about the role, not about the inputs |
| every staff action audited with the role that permitted it | `audits the refusal with the actor and the role` — the denied viewer leaves an `audit_log` row: `actor_kind staff`, `actor_role viewer`, `outcome error`, `error_code not_allowed`. A refusal that left no trace would be the worst of both worlds |
| the seeded account is an admin | `creates once and is a no-op on every boot after` now also asserts `session.operator.role === 'admin'` |

**The bar was checked by breaking it.** With the single `requireCapability` line removed
from the guard, `refuses a viewer every mutating command` and `audits the refusal` both
fail and the other two pass; restored, all four pass. The test reads the guard, not a
coincidence.

## Verification

`tasks/todo.md`'s Verify line reads `npm test src/staff/*.test.ts`. That glob matched
**nothing** when written — every staff test was under `internal/` or `ui/`. It now matches
the new contract test and still misses the other three files, so it was widened, as 6.1,
6.2 and 7.1 each were:

```
npm test src/staff/contract.test.ts src/staff/internal/*.test.ts src/staff/ui/*.test.ts
→ 43 tests, 43 pass, 0 fail, 0 skipped
```

15 of those are the pure `internal/roles.ts` unit — the whole 3×3 grid written out, so a
fourth capability cannot be added without deciding every role's answer to it.

Full CI gate, run locally exactly as CI runs it:

```
npm run typecheck   → clean
npm run lint        → 73 files, no fixes applied
REQUIRE_POSTGRES=1 npm test → 236 pass, 0 fail, 0 skipped   (214 → 236; run three times, identical)
npm run evals       → 3/3
```

## The migrations, proved against the real database

Not inferred from the SQL — read back out of Postgres after the runner applied them:

```
0007_audit_actor_role.sql   applied 2026-08-24 17:14:57.151721+00
0008_staff_roles.sql        applied 2026-08-24 17:14:57.153892+00

staff_operators.role   is_nullable NO   column_default (none)
                       CHECK (role = ANY (ARRAY['admin','operator','viewer']))
audit_log.actor_role   is_nullable YES  (no CHECK)
```

- **The backfill did what it is there for:** of the operators whose `created_at` predates
  `0008`, **351 of 351** now read `admin`. That is the mechanism by which the account
  already seeded on staging and prod becomes an admin — the seeder creates but never
  updates, so a migration is the only thing that can reach a row that already exists.
- **`actor_role` is genuinely nullable, not nullable-and-always-filled:** of the 3,522
  audit rows written before `0007`, **0** carry a role, and they are still readable.
- **Both files re-apply clean** over an already-migrated database (`ON_ERROR_STOP=1`,
  `IF NOT EXISTS` on the columns, a guarded `DO` block on the constraint) — so a
  half-applied deploy is recoverable by re-running rather than by hand.

## Decisions on the record

- **The capability matrix is code, not a config row** — a stated exception to SPEC.md
  rule 4 ("policies are data"), written into `SPEC-staff.md`. Rule 4 governs tunables:
  rates, timeouts, deductibles, kill switches. An access-control matrix that a database
  write could widen is a privilege-escalation path whose exploit is an `UPDATE`. Changing
  who may mutate should cost a deploy and leave a diff.
- **`actor_role` is a column, not a field inside `inputs`.** `inputs` means the arguments
  to the command; the role that permitted the actor is a different fact, and the week-2
  demo wants to filter two sessions apart on it.
- **A successful staff mutation writes two audit rows, deliberately** — the edge row says
  who was allowed and why, the module row says what changed. Asserted as such in
  `audits a permitted mutation at the edge and in the module`, and written into
  `SPEC-staff.md` so it is not read later as duplication worth "cleaning up".
- **No `DEFAULT` on `role`**, as in 0004–0006: a caller that does not name a role is a
  bug, and the fail-closed answer is a refusal rather than the most convenient value.
  `createOperator` validates through `validRole` at the edge for the same reason.
- **The seeded role is fixed at `admin`, not env-driven.** A `STAFF_SEED_ROLE` that could
  be set to `viewer` is a way to deploy a system with no way to administer it.

## Gaps, stated

- **No UI, by design.** No route calls the guarded surface yet; slice 10.1 builds the
  people and properties views on top of it. This slice's proof is a test that calls the
  command directly, which is the point — a button that hides itself is not a permission.
- **The viewer account for Friday's demo does not exist yet and cannot be created by the
  system.** The seeder creates but never updates, and there is no operator-management
  screen (`administer` is named in the matrix but has no command behind it). Making that
  account on staging is a manual `INSERT` today. Flagged now so 10.2 does not discover it
  on Friday morning.
- **The carried-in `staff` session-sweep flake was left carried**, deliberately, though
  this slice edits the file it lives in. It wants `SPEC-staff.md` reasoning of its own and
  a fix to `login()`/`readSession()`, which is a different change from roles. Three
  consecutive full gate runs at 236/236 here; it has not fired since.
