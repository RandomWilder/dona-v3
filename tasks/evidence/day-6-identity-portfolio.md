# Evidence — Day 6: `identity` and `portfolio`, the two independent modules

Captured 2026-08-24. GitHub Actions runs age out of the UI; this is the durable record.

Day 6 built the two modules that slice 7.1 joins. They are the first **domain** modules in
the repo — `staff` is the admin-panel edge and `channel` is an adapter — so between them
they also set the shape every later module copies: a migration the kernel runs but never
reads, a `contract.ts` that is the whole public surface, internals nobody may import, and
contract tests written only against the commands.

## The acceptance bars

| slice | bar | how it was met |
|---|---|---|
| 6.1 | a phone number in any of the three formats resolves to the same person | `resolves every format of one number to the same person` — four spellings (`050-…`, `0501234567`, `+9725…`, `9725…`) added once and looked up four ways, all returning one person id |
| 6.1 | a second `addPerson` with the same intent key returns the first result | `returns the first result for a repeated intent key` — results deep-equal, and `count(*) = 1` in `identity_people` |
| 6.2 | contract tests cover the tree building → unit → asset | `records building → unit → asset and reads the tree back` — written through three commands, read whole through `getUnit` |
| 6.2 | a unit cannot be created under a building that does not exist | `refuses a unit under a building that does not exist` → `not_found` |

Neither bar is met by inspection: each is a named test that fails if the behaviour goes.

## The pipeline

| slice | PR | CI on the PR | merge | deploy | revision |
|---|---|---|---|---|---|
| 6.1 | [#7](https://github.com/RandomWilder/dona-v3/pull/7) | [32653758115](https://github.com/RandomWilder/dona-v3/actions/runs/32653758115) — `gate` + `evals` green | `5a4f12a` | [32654216855](https://github.com/RandomWilder/dona-v3/actions/runs/32654216855) — success | `dona-staging-00014-hxq` |
| 6.2 | [#8](https://github.com/RandomWilder/dona-v3/pull/8) | [32690739487](https://github.com/RandomWilder/dona-v3/actions/runs/32690739487) — `gate` + `evals` green | `ffc050f` | [32690934824](https://github.com/RandomWilder/dona-v3/actions/runs/32690934824) — success | `dona-staging-00015-4rq` |

Staging now:

```
$ curl -s https://dona-staging-ydabrrmura-zf.a.run.app/health
{"ok":true,"version":"ffc050f","db":"up"}

boot line, revision dona-staging-00015-4rq:
dona-v3 ffc050f listening on 0.0.0.0:8080 — staff seed: already exists
```

**Both migrations reached staging's Cloud SQL.** This is an inference and worth stating as
one: `boot.ts` runs `migrate()` before `listen()`, and Cloud Run marks a revision ready only
once the container listens. A failing migration throws before that, so the revision would
never have become ready and the deploy would have gone red. It went green and holds 100% of
traffic — therefore `0004` and `0005` applied. Nothing was queried against the staging
database directly.

## What CI actually ran

| run | tests | skipped |
|---|---|---|
| before day 6 (`20c5b4e`) | 76 | 0 |
| after 6.1 | 118 | 0 |
| after 6.2 | 141 | 0 |

**65 tests added in a day, none skipped.** `REQUIRE_POSTGRES=1` is what makes the zero
meaningful: without it an unreachable database turns the whole durability suite into a
silent pass, and both modules are almost entirely durability tests.

The golden set ran 3/3 on both PRs. Neither slice touches a prompt, a model id, retrieval
or a tool definition, so it could not have moved — it gates the merge regardless.

## The schema, proved rather than inferred

Against the local database after `migrate()`:

```
schema_migrations: 0001_init · 0002_kernel_durability · 0003_staff_auth
                   · 0004_identity · 0005_portfolio

identity_phones_pkey            PRIMARY KEY, btree (phone)
portfolio_assets_..._label_key  UNIQUE CONSTRAINT, btree
                                (building_id, unit_id, kind, label) NULLS NOT DISTINCT
portfolio_assets_unit_id_building_id_fkey
                                FOREIGN KEY (unit_id, building_id)
                                REFERENCES portfolio_units(id, building_id)
```

Those three lines are the day's load-bearing constraints:

- **`identity_phones.phone` as the primary key** — one number belongs to exactly one person,
  system-wide, by schema rather than by care.
- **`NULLS NOT DISTINCT`** — two building assets of one kind collide instead of duplicating,
  which a plain unique index would not do, because their `unit_id` is NULL.
- **the composite foreign key** — an asset cannot name unit 3 of one building and the address
  of another.

No `created_at` column in either migration carries `DEFAULT now()`; a test in each module
asserts the stored time is the injected clock's (SPEC-kernel.md decision 3).

## The boundaries hold

Every import in both modules, counted:

```
kernel/errors.ts · kernel/ids.ts · kernel/clock.ts · kernel/audit.ts
kernel/idempotency.ts · kernel/pg-support.ts · pg · node:test · node:assert
+ each module's own files
```

Neither module imports the other, and nothing outside a module reaches its `internal/`.
`portfolio` mentions `identity` only in two comments. This is checkable in one grep and
should be re-checked whenever a module is added, because it is the invariant that makes
the monolith modular rather than merely tidy.

## Three decisions that outlive day 6

1. **Intent keys where identity is unnatural; unique indexes where it is not.**
   `identity.addPerson` takes a caller-supplied `intentKey` because two tenants can share a
   name and a person has no natural key. `portfolio` uses **none** — a building *is* its
   address, a unit *is* its label within one — so all three of its creates are idempotent on
   unique indexes and the kernel's `once()` is unused in that module. Both specs record the
   contrast so it is not relitigated per module.
2. **`null` for a miss on a user-supplied key; `not_found` for a miss on a system id.**
   `findByPhone` returns `null` because "nobody has this number" is a true answer about the
   world. `getUnit(id)` throws `not_found` because the id must have been issued by something,
   so a miss is a dangling reference. Written down once, in `SPEC-portfolio.md`, for the
   whole codebase.
3. **Fail-closed reads for sensitive fields.** A building's access note is "code 4471, key in
   the meter cupboard". `getUnit` omits access notes unless the caller asks for them, so a
   leak requires an explicit request rather than a forgotten `delete`. A test asserts `4471`
   appears nowhere in a default read.

## Deliberately not done

- **No HTTP surface for either module.** Nothing is wired into the composition root; the
  admin people and properties views are slice 10.1. The migrations run at boot regardless,
  which is why both modules are already on staging without being reachable.
- **No listing commands** (`listBuildings`, units under a building) — 10.1 needs them and the
  screen that needs them should shape them.
- **No edits, no deletes, no person merge/split.** Everything is additive. This is what makes
  first-result-wins idempotency safe to ship: nothing silently overwrites.
- **Address normalisation does not guess.** It knows whitespace, case, and leading zeros on
  numeric unit labels. It does *not* know that `רח׳` is `רחוב`, and a test asserts it does
  not — real pilot addresses arrive on day 8, and a wrong guess **merges two real buildings**,
  which is worse than leaving two spellings apart for the importer to map deliberately.

## Carried into day 7

- **`requireText` / `validId` / `optionalText` are duplicated** in `identity/internal/people.ts`
  and `portfolio/internal/places.ts`. `occupancy` would be the third copy, which is the point
  at which extracting them into the kernel is warranted rather than premature. That touches
  kernel surface and `SPEC-kernel.md`, so it is a plan-mode decision at the top of 7.1 — not
  something to smuggle into a slice.
- **ROADMAP week 2's module checkbox stays open.** Its bar is "phone → person → unit → current
  occupancy resolves", and the right-hand half does not exist yet. Two thirds of that line is
  done; the line is not.
