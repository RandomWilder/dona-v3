# Evidence — Slice 7.1: `occupancy`, the join

Captured 2026-08-24. GitHub Actions runs age out of the UI; this is the durable record.

`identity` knows people, `portfolio` knows places, and until this slice nothing in the
system knew the two were related. `occupancy` is that relation, and it is the seam SPEC.md's
**"absolute tenant isolation enforced at the query layer"** hangs on: every read in weeks
3–5 is scoped by what `resolveByPhone` returns. So it got its isolation tests before it got
features, and the acceptance bars below are all named tests rather than inspection.

## The acceptance bars

| bar | how it was met |
|---|---|
| `phone → person → unit → current occupancy` resolves end to end | `resolves phone → person → unit → current occupancy` — a number handed over in a spelling nobody chose (`+972-…`) reaches the right unit, with the tenancy's parking bay and storage attached |
| the isolation test proves it cannot cross tenancies | `does not let one tenancy reach another` — two households on one staircase, each phone reaching exactly its own unit and exactly one tenancy, asserted in both directions |
| a guarantor does not get a tenant's access | `gives a guarantor his tenancy without giving him a tenant's access` — one tenancy, two answers: `roles: ['guarantor'] / access: 'party'` against `roles: ['tenant','billed'] / access: 'resident'` |
| an ended occupancy must not resolve at all | `stops resolving a tenancy once it has ended` — the person stays known, the list goes empty. `does not resolve a tenancy that has not started` covers the other end |

## Verification

Run as `tasks/todo.md` specifies, with the glob widened as in 6.1 and 6.2:

```
npm test src/occupancy/*.test.ts src/occupancy/internal/*.test.ts
→ 37 tests, 37 pass, 0 fail, 0 skipped
```

23 of those are the two pure units (`internal/roles.ts`, `internal/dates.ts`); 14 are
contract tests.

Full CI gate run locally as CI runs it:

```
npm run typecheck   → clean
npm run lint        → 63 files, no findings
REQUIRE_POSTGRES=1 npm test → 190 tests, 190 pass, 0 fail, 0 skipped
npm run evals       → 3/3
```

141 → **190** tests across the slice. Run three times consecutively, identical each time.

## The migration, proved rather than inferred

`0006_occupancy.sql`, read back from the running database:

- present in `schema_migrations`, sixth of six
- `occupancy_tenancies_unit_id_fkey` → `portfolio_units(id) ON DELETE RESTRICT`, and
  `occupancy_parties_person_id_fkey` → `identity_people(id) ON DELETE RESTRICT` — the two
  keys that cross module lines, on purpose and in the declared dependency direction
- `UNIQUE (unit_id, starts_on)` — the natural key, which is what makes day 8's importer
  re-runnable
- `CHECK (ends_on IS NULL OR ends_on >= starts_on)`, and the three-value role CHECK
- **no `DEFAULT` on any column**, `created_at` included: all eleven columns report `(none)`,
  so the injected clock stays the only source of time

## The one that caught a mistake in the spec

`resolveByPhone` compares against the injected clock rendered in `Asia/Jerusalem`. The first
draft of `SPEC-occupancy.md` justified this with the reasoning backwards — it claimed a UTC
comparison would roll the date over *early*, at 22:00 local. Israel runs two or three hours
**ahead** of UTC, so the Israeli date advances first and a UTC comparison lands every
boundary up to three hours **late**. The test failed on the assertion the wrong reasoning had
produced, and the spec was corrected to match reality rather than the test to match the spec.

The corrected boundary is pinned from both sides, at `21:30Z` — 00:30 the next morning in
Tel Aviv:

| instant | Tel Aviv | UTC | tenancy 2026-09-01 → 2026-09-30 |
|---|---|---|---|
| `2026-08-31T21:30:00Z` | 1 Sep | 31 Aug | **current** — UTC would say "not yet", on the morning she moved in |
| `2026-09-30T21:30:00Z` | 1 Oct | 30 Sep | **over** — UTC would still be answering for someone who has left |

Both flip if the `AT TIME ZONE` is dropped, confirmed directly against Postgres, so the test
discriminates rather than merely passing.

## The kernel extraction

`requireText` / `optionalText` / `validId` / `asText` were duplicated in `identity` and
`portfolio`; `occupancy` would have been the third copy. They now live in
`src/kernel/validate.ts` with a section in `SPEC-kernel.md`, and both existing modules were
refactored onto them.

The line drawn: the kernel holds the *shape* of a value and nothing more. Validators that
know a domain word stayed in their modules — `portfolio`'s `validKind` and `optionalFloor`,
`identity`'s `validKinds` and `validLanguage`, `occupancy`'s `validRole`.

**No test in `identity` or `portfolio` was edited.** That is the proof the extraction changed
nothing: 141 tests that were written against the old private copies pass unaltered against
the kernel's.

## Module boundaries, checked rather than assumed

Every cross-module import in `src/occupancy` is `../identity/contract.ts` or
`../portfolio/contract.ts`. Nothing anywhere in the module names another module's
`internal/`. Both dependencies are injected through `OccupancyDeps` typed by their own
contracts, so the dependency is visible in the constructor rather than buried in a join.

## Found in passing, not fixed here

`src/staff/internal/auth.test.ts:99` ("expires a session on the clock, without sleeping")
failed once in five runs of the gate and passed the other four. It is a real flake, not a
one-off: `login()` and `readSession()` in `src/staff/internal/auth.ts` each sweep **every**
expired session in the database using their own clock's `now`. `node --test` runs files in
parallel against one database, and `staff/ui/routes.test.ts` and `staff/internal/seed.test.ts`
both build a `staff` auth on the *system* clock — so their sweep deletes the fixed-clock
test's still-valid 2026-08-23 session mid-assertion.

It belongs to `staff`, not to `occupancy`, so it was flagged rather than folded into this
slice. Carried at the bottom of `tasks/todo.md`.
