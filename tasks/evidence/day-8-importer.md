# Evidence — Slice 8.1: the tenant mapping importer

Captured 2026-08-24. **The slice is not closed.** Two of its three acceptance bars are met;
the third needs a file Dona Dom has not sent. That is stated here first rather than
discovered at the bottom.

## Why it was built ahead of its data

Fuse #3 (`tasks/fuses.md`) was fired 2026-08-22 and acknowledged; the tenant↔unit↔phone
table had still not arrived two days later. `ROADMAP.md:175` names this exact case and its
answer: *"Pilot data arrives late → Weeks 2–3 run on a realistic seeded building; importer
makes swap-in a one-hour job."* So the importer and a seeded fixture were built, and the
real-file verification was left open rather than simulated.

The alternative considered and rejected: verifying against synthetic data. A synthetic file
contains only the mess someone thought to invent, so passing against it proves the author's
imagination rather than the importer. PIPELINE.md §9 names that anti-pattern directly —
*"an agent that 'worked when I tried it' is untested."*

## The bars

| bar | state |
|---|---|
| re-running is a no-op | ✔ proved on the database — five row counts identical across two `--commit` runs |
| the slice imports | ✔ **the seeded building**, not the pilot one |
| 5 spot-checks against the source document | ☐ **needs the real file** |

## The idempotency, proved rather than argued

Run directly against the local database, counting `portfolio_buildings`, `portfolio_units`,
`identity_people`, `occupancy_tenancies`, `occupancy_parties`:

```
before:            327 251 248 104 112
after 1st commit:  328 253 253 106 118
after 2nd commit:  328 253 253 106 118
```

The second run reported the same `applied 6 · rejected 5` and changed nothing. Note what
the deltas say: **six applied rows produced two tenancies and five people**, because three
of them describe one household and two describe another. Rows are parties, not tenancies.

This works because the importer keeps **no state of its own**. Every command underneath is
already idempotent on a natural key — `portfolio` on the address and the unit label,
`occupancy` on `(unit_id, starts_on)` and the party primary key, `identity` on the caller's
intent. The importer owns no table and could be deleted without losing a fact.

## The one design decision that changed a spec

`identity.addPerson` needs an intent key, and `SPEC-identity.md` said the importer's key
would be **its source row**. That is wrong, and building the thing showed why: a row number
moves when the file is re-sorted or when a line is inserted near the top, and every key
below it shifts — minting a second person for someone who already exists. That is precisely
the duplication `identity` exists to prevent.

The key is the **normalised phone** instead: the one thing about a row that cannot move, and
one phone is one person by schema. `SPEC-identity.md` was amended rather than quietly
diverged from, and a test imports the same two rows in both orders and asserts two people,
not four.

The consequence is recorded in `SPEC-import.md`: the importer creates and never updates. A
corrected name in a re-imported file does nothing.

## Format: ours, not theirs

Dona Dom's shape is unknown — "organized by apartment, phone numbers included" is all that
was promised. So `SPEC-import.md` states what we accept and the importer refuses anything
else by name; reconciling their export is a header rename done deliberately when it arrives.

**One row is one party of one tenancy** — the load-bearing choice. The real lease carries two
tenants and two mobile numbers with nothing saying which is whose
(`docs/reference/lease-template-donadom.md`). A format with two name columns and two phone
columns would force the importer to pair them. One row, one person, one phone means it is
never in a position to guess, and a household that genuinely cannot be split goes back to a
human instead of into the database.

## Verification

```
npm test src/import/*.test.ts src/import/internal/*.test.ts
→ 24 tests, 24 pass, 0 fail, 0 skipped     (15 CSV parser + 9 contract)

npm run typecheck            → clean
npm run lint                 → 69 files, no findings
REQUIRE_POSTGRES=1 npm test  → 214 tests, 214 pass, 0 fail, 0 skipped
npm run evals                → 3/3
```

190 → **214** across the slice.

End to end against the shipped fixture, which is also a test so it cannot rot:

```
DRY RUN — nothing was written
read 11 · would apply 6 · rejected 5
  line 8:  invalid — starts_on is not a date
  line 9:  invalid — role must be one of tenant, billed, guarantor, not "landlord"
  line 10: invalid — phone number is invalid
  line 11: invalid — person_name is empty
  line 12: invalid — ends_on is before starts_on
```

Five rows, each wrong in a different way, each naming its line. A separate test lands a good
row sitting between two bad ones, which is the actual bar — "reports rejects" is worthless
if a reject takes its neighbours down.

## Two promotions onto existing contracts

`normalizePhone` → `identity/contract.ts`, and `validDate` / `optionalDate` →
`occupancy/contract.ts`. Both specs had already named this caller as the likely first
(`SPEC-identity.md`, "Not yet in place"). The importer must reject a bad date and an
unreachable number *before* it writes, and re-deriving either rule locally would be a second
copy that drifts from the one the commands enforce. No behaviour changed; both specs record
the promotion.

## Boundaries

Every cross-module import in `src/import` and `src/import.ts` is a `contract.ts` — identity,
portfolio, occupancy — or a kernel file. Nothing reaches into another module's `internal/`.

## What is honest about the dry run

It **validates; it does not simulate.** It applies every field rule through the same module
functions the commands use, so a row it accepts is a row those commands accept — but it does
not execute the writes, so it cannot surface a failure that only exists in the database's
current state.

That gap is nearly empty today: every command called is idempotent, and because a person is
keyed by their phone, the one `conflict` `identity` can raise is unreachable through this
path. It would stop being empty if a future column or command introduced one. Simulating
properly means the module commands must accept a transaction rather than a pool — a real
change to four modules, and its own slice rather than something smuggled into this one.
Recorded in `SPEC-import.md` rather than left for someone to discover.

## To close this slice

`npm run import -- <file>` (dry), read the rejects, `--commit` against staging, then five
`resolveByPhone` spot-checks against the source document. Fuse #3 next checked 2026-08-25.
