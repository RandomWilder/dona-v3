# Week 2 — Identity, portfolio, occupancy, roles

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployed. Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** the real pilot building lives in the system; staff access is role-gated and audited.
**Week demo (Friday):** log in as viewer and as admin — different powers, proven by a test rather than by hidden buttons; the audit trail shows both sessions; the pilot building is browsable on staging.

Previous week: `tasks/week-1.md` (closed — a login-gated shell live on prod).

### Done before day 6 — build identity on `/health` ✔
Found in the week-1 sign-off audit: prod served the `v0.1.0` release while `/health`
reported `0.1.0-dev`, so nothing from outside could tell a release from a hand-rolled
deploy. `version` now comes from `APP_VERSION`, injected by the pipeline that deployed
it — the tag on prod, the short commit on staging — and the fallback still ends in
`-dev`, so a deployed URL saying `-dev` now means the injection did not happen.
**Verified 2026-08-23:** staging reports `cb49bc7`, prod reports `v0.1.1`
([release](https://github.com/RandomWilder/dona-v3/actions/runs/32641913957),
revision `dona-prod-00004-zvs`), all three secrets intact after the env-var change,
and prod's boot line reads `staff seed: already exists` — the seeder's idempotency
proving itself on a real second deploy rather than in a test.

---

## Day 6 (Mon) — The two independent modules

### Slice 6.1 — `identity`: people, phones, roles ☑
- [x] Migration + `SPEC-identity.md` written **before** the code: person, phone (E.164, normalised), person-kind (tenant / vendor / staff — a person can be more than one). `0004_identity.sql`; `identity_phones.phone` is the **primary key**, so one number belongs to one person by schema rather than by care
- [x] Commands through `contract.ts` only: `addPerson`, `addPhone`, `findByPhone`. Idempotent on business intent, audited, validated at the edge. Two kinds of idempotency, deliberately: `addPerson` takes an `intentKey` through the kernel's `once()` (a person has no natural key — two tenants can share a name), `addPhone` is idempotent on the unique index itself. Validation runs *inside* `audit.around`, so a rejected command leaves an `error` row instead of no row
- [x] Phone normalisation is its own tested unit: Israeli numbers arrive as `050-…`, `+9725…`, `9725…` and must resolve to one person. `internal/phone.ts` — pure, 33 cases, Israeli by default and international only when the caller writes `+`

**Done when:** a phone number in any of the three formats resolves to the same person; a second `addPerson` with the same intent key returns the first result.
**Verify:** `npm test src/identity/*.test.ts src/identity/internal/*.test.ts` — *the glob was widened*: as written it missed `internal/phone.test.ts`, which is the unit this slice explicitly requires · Size: M

**Verified 2026-08-23:** 42 identity tests pass (33 normalisation + 9 contract). Both halves of *Done when* are named tests: four spellings of one number resolve to one person id, and a repeated `intentKey` returns the first result with exactly one row in `identity_people`. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **118 pass, 0 skipped** · `npm run evals` → 3/3. Migration proved against the real database rather than inferred: `0004_identity.sql` in `schema_migrations`, `identity_phones_pkey` on `phone`, and no `DEFAULT now()` on any `created_at` — a test asserts the stored time is the injected clock's. Record: `tasks/evidence/day-6-identity-portfolio.md`

### Slice 6.2 — `portfolio`: buildings, units, assets ☑
- [x] `SPEC-portfolio.md`, then migration: building, unit, asset (boiler, lift, intercom…), access notes. `0005_portfolio.sql`. **Deviation, sanctioned:** an asset names its building always and its unit *optionally* — `unit_id IS NULL` is a building asset, so a lift is the building's rather than whichever flat it was parked under. A composite FK `(unit_id, building_id)` makes pairing a unit with the wrong building impossible
- [x] Commands: `addBuilding`, `addUnit`, `addAsset`, `getUnit`. No dependency on identity — portfolio is about places, not people. **No intent keys anywhere in this module:** a place has natural identity (a building *is* its address, a unit *is* its label within one), so all three creates are idempotent on unique indexes and the kernel's `once()` is unused here — the contrast with `identity` is recorded in both specs
- [x] Access notes are opt-in on the read (`getUnit(id, { includeAccessNotes: true })`) — they are entry codes, and a caller must ask rather than remember to strip
- [x] Key normalisation is its own tested unit (`internal/keys.ts`, 12 cases), deliberately naive: whitespace and case, plus leading zeros on numeric unit labels. It does **not** know `רח׳` is `רחוב` — real addresses arrive day 8, and a wrong guess merges two real buildings

**Done when:** contract tests cover the tree building → unit → asset, and a unit cannot be created under a building that does not exist.
**Verify:** `npm test src/portfolio/*.test.ts src/portfolio/internal/*.test.ts` — *glob widened*, as in 6.1: as written it missed `internal/keys.test.ts` · Size: M

**Verified 2026-08-24:** 23 portfolio tests pass (12 key normalisation + 11 contract). Both halves of *Done when* are named tests: the tree is written and read back whole through `getUnit`, and a unit under an unknown building is refused `not_found`. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **141 pass, 0 skipped** · `npm run evals` → 3/3. Migration proved against the real database: `0005_portfolio.sql` in `schema_migrations`, the composite FK `portfolio_assets_unit_id_building_id_fkey` present, and the unique constraint reported by Postgres as `NULLS NOT DISTINCT` — which is what makes two building assets of one kind collide instead of duplicating. Record: `tasks/evidence/day-6-identity-portfolio.md`

> **Day 6 closed 2026-08-24.** Both modules exist and neither imports the other — checked, not assumed: every import in both is `kernel/*`, `pg`, or a node built-in. Live on staging as `ffc050f` (`dona-staging-00015-4rq`); CI went 76 → 118 → **141 tests, 0 skipped** across the day. Sign-off: `tasks/evidence/day-6-identity-portfolio.md`.
>
> Open at the top of 7.1: `requireText` / `validId` / `optionalText` are now duplicated in both modules and `occupancy` would be the third copy. Extracting them to the kernel touches kernel surface and `SPEC-kernel.md` — a plan-mode decision, taken deliberately rather than smuggled into a slice.

## Day 7 (Tue) — The join that the whole product rests on

> **Added 2026-08-24, ahead of 7.1.** A real signed lease arrived from Dona Dom. Reviewing it settled where real tenant documents live, and that decision is infrastructure — so it lands through `bootstrap.sh` before any slice needs it, rather than by hand when day 8 does. Findings from the document: `docs/reference/lease-template-donadom.md`.

### Slice 7.0 — private document store ☑
- [x] `gs://dona-v3-staging-docs` + `gs://dona-v3-prod-docs` provisioned **in `infra/bootstrap.sh`**, idempotently, per the house rule that infrastructure is never provisioned by hand
- [x] Created closed and re-closed on every run: public access prevention **enforced**, uniform bucket-level access, versioning on, `me-west1` so Israeli tenants' documents stay in Israel
- [x] Least privilege: `roles/storage.objectViewer` on that one bucket for that environment's runtime account only — never a project-level storage role, so `app-staging` cannot read prod's documents. **No write access**: nothing uploads leases until week 3, and `objectCreator` is granted in the slice that needs it
- [x] Object paths carry the place, never the people — paths reach logs and audit entries, which is exactly where personal data must not appear
- [x] The sample lease uploaded to both environments (decision on the record: staging holds real leases, because ROADMAP week 3's demo and day 8's verification are both written against staging)

**Done when:** both buckets exist with all four controls, the app can read only its own, and an unauthenticated request gets nothing.
**Verify:** `bootstrap.sh` re-run clean on both environments; `gcloud storage buckets describe` reports `ME-WEST1 / True / enforced / True`; unauthenticated `curl` of an object returns **403** and a bucket listing **401**. · Size: S

**Verified 2026-08-24:** `./infra/bootstrap.sh staging` and `prod` both re-ran clean over existing resources. Both buckets report `ME-WEST1  True  enforced  True`. IAM on each grants `objectViewer` to that environment's runtime account and nothing broader. The lease uploaded to both at 1,695,258 bytes, byte-for-byte the source. Unauthenticated `curl` → **403** on the object in both environments, **401** on the bucket listing. Scrubbing of the reference note checked mechanically: no names, ID numbers, phones, emails, bank references or amounts — the only multi-digit number in the file is the year.


### Slice 7.1 — `occupancy`: who lives where, who is billed ☑
- [x] `SPEC-occupancy.md` written before the code, then `0006_occupancy.sql`. Depends on identity + portfolio **through their `contract.ts` only** — both injected through `OccupancyDeps` typed by their own contracts, so the dependency is visible in the constructor rather than buried in a join. Checked, not assumed: every cross-module import in the module is one of those two files
- [x] `resolveByPhone(phone)` — returns **a person and a list of current tenancies**, never a single guessed one: `null` means nobody holds the number, `[]` means a known person who lives nowhere, and a person renting two flats is a fact rather than a conflict. "Most recent wins" was rejected as the one shape that can silently answer about the wrong flat. Access notes are never requested, so an entry code cannot reach a resolution by accident
- [x] Isolation test: two households on one staircase, each phone reaching exactly its own unit, asserted in both directions; an ended tenancy resolves to `[]` and a not-yet-started one likewise. **"Current" is read on Israeli dates** — Israel runs ahead of UTC, so a UTC comparison lands every boundary up to three hours late in both directions; pinned at `21:30Z` from each side, and both assertions flip if the `AT TIME ZONE` is dropped

**Scope added 2026-08-24**, from the real lease (`docs/reference/lease-template-donadom.md`). Both are cheap now and become migrations against real tenant data once day 8 imports:
- [x] **A role on the occupancy↔person link** — `tenant` / `billed` / `guarantor`, one row per role, so a person who lives there *and* pays holds two. On the link and not on the person, which is what lets one man guarantee his daughter's flat while renting his own; `identity` was not touched
- [x] **The isolation test covers him too:** one tenancy, two answers — `roles: ['guarantor'] / access: 'party'` against `roles: ['tenant','billed'] / access: 'resident'`. `tenancyAccess` is a pure function in `internal/roles.ts`, computed once from the link, and week 3's document retrieval is scoped by it rather than re-deciding the question. A `billed` party who is not also a tenant is a `party` too — being on the hook for the money is not the same as living behind the door
- [x] **Parking and storage on the occupancy**, nullable — they travel with the tenancy, so a reassignment does not rewrite the place itself

- [x] **The kernel extraction, taken in plan mode as it required.** `requireText` / `optionalText` / `validId` / `asText` now live in `src/kernel/validate.ts` with a section in `SPEC-kernel.md`, and `identity` and `portfolio` were refactored onto them. The line drawn: the kernel holds the *shape* of a value and nothing more — validators that know a domain word stayed put (`validKind`, `optionalFloor`, `validKinds`, `validLanguage`, `validRole`). **No test in either module was edited**, which is the proof the extraction changed nothing: 141 tests written against the old private copies pass unaltered against the kernel's.

**Note, not scope:** the lease's term is an initial period plus two options capped at ten years, and rent is an index-linked formula rather than a number. `resolveByPhone` only needs "is this current", so neither changes 7.1 — but the week-3 digital twin must not store a single end date or a single rent figure.

**Done when:** `phone → person → unit → current occupancy` resolves end to end; the isolation test proves it cannot cross tenancies, and that a guarantor does not get a tenant's access.
**Verify:** `npm test src/occupancy/*.test.ts src/occupancy/internal/*.test.ts` (glob widened as in 6.1 and 6.2) · Size: M→L, given the added scope

**Verified 2026-08-24:** 37 occupancy tests pass (23 across the two pure units, 14 contract). All four halves of *Done when* are named tests — the chain end to end, the two-household isolation, the guarantor's two-answers-one-tenancy, and both the ended and the not-yet-started tenancy. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **190 pass, 0 skipped** (run three times, identical) · `npm run evals` → 3/3. Migration proved against the real database rather than inferred: `0006_occupancy.sql` in `schema_migrations`, both cross-module foreign keys present with `ON DELETE RESTRICT`, `UNIQUE (unit_id, starts_on)` — the natural key day 8's importer rests on — and **no `DEFAULT` on any of the eleven columns**. One correction on the record: the spec's first draft had the timezone reasoning backwards and the test caught it; the spec was fixed to match reality rather than the test to match the spec. Record: `tasks/evidence/day-7-occupancy.md`

> This is the seam SPEC.md's "absolute tenant isolation enforced at the query layer" hangs on. Every read in weeks 3–5 is scoped by what this returns, so it gets isolation tests before it gets features.

## Day 8 (Wed) — Real data in

### Slice 8.1 — CSV importer for the tenant mapping table ☐
- [x] Idempotent and re-runnable — and **not by the importer's own bookkeeping**: every command underneath is already idempotent on a natural key, so the importer keeps no ledger and writes no table of its own. Proved against the real database: a second `--commit` of the same file left all five row counts identical. The person's intent key is the **normalised phone, not the source row** — a row number moves when the file is re-sorted, which would mint a second person for someone who already exists. `SPEC-identity.md` said "source row" and was amended rather than quietly diverged from
- [x] Reports rejects rather than failing the run — `{ line, code, reason }`, the line counted through quoted newlines so it points at what the operator sees in their spreadsheet. A test lands a good row sitting between two bad ones. Only a **structural** failure aborts (ragged row, unterminated quote, missing column), because after one the line numbers are meaningless and a reject list with wrong lines is worse than none
- [x] Dry-run mode, and it is the **default** — `--commit` is required to write. Stated honestly in `SPEC-import.md`: it *validates* rather than *simulates*. It applies every field rule through the same module functions the commands use, but does not execute the writes, so it cannot surface a failure that only exists in the database's current state. That set is nearly empty here (keying a person by phone makes `identity`'s one conflict unreachable), and simulating properly needs the module commands to take a transaction rather than a pool — four modules, its own slice

**Done when:** the real pilot slice imports; re-running is a no-op; 5 spot-checks against the source document pass.
**Verify:** import the real file into staging, then 5 manual `resolveByPhone` lookups. · Size: M

**Built 2026-08-24 — slice stays open, two bars of three met.** The importer, its format and its fixture exist and are tested; the third bar needs a file that has not arrived. Built ahead of the data on `ROADMAP.md:175`'s own contingency ("weeks 2–3 run on a realistic seeded building; importer makes swap-in a one-hour job"), and on Asaf's call to start 8.1 rather than let the fuse idle the day.

- **Re-running is a no-op** ✔ — proved on the real database, not inferred: five row counts identical across two `--commit` runs.
- **A realistic slice imports** ✔ — but the *seeded* building, not the pilot one. `src/import/fixtures/pilot-sample.csv`: one household of three parties, a second of two, five rows each wrong in a different way. 6 applied, 5 rejected, every reject naming its line.
- **5 spot-checks against the source document** ☐ — **needs the real file.** Cannot be faked, and a synthetic pass here would be exactly the "trusting the demo" anti-pattern PIPELINE.md §9 names.

Also here: `normalizePhone` promoted onto `identity`'s contract and `validDate` / `optionalDate` onto `occupancy`'s — both to the caller their specs predicted, so the importer enforces the same rule the commands do instead of carrying a second copy that drifts.

**Verified so far 2026-08-24:** 24 import tests (15 CSV parser + 9 contract). Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **214 pass, 0 skipped** · `npm run evals` → 3/3. 190 → 214. Record: `tasks/evidence/day-8-importer.md`

**To close this slice** when the table arrives: `npm run import -- <file> ` (dry), read the rejects, then `--commit` against staging, then 5 `resolveByPhone` spot-checks against the source document.

> **Depends on Dona Dom.** Lease PDFs and the tenant↔unit↔phone table were requested and acknowledged 2026-08-22 (`tasks/fuses.md`). If the data has not arrived by Wednesday this slice slips and Day 9 moves up — the importer can be built against a synthetic file, but it cannot be *verified* against one.

## Day 9 (Thu) — Roles on top of the login

### Slice 9.1 — admin / operator / viewer ☑
- [x] Roles on `staff_operators`, checked **server-side per command** — never by hiding a button. `0008_staff_roles.sql`: `NOT NULL`, `CHECK` on the three names, and **no `DEFAULT`**, as in 0004–0006 — a caller that does not name a role gets a refusal rather than the most convenient value. The matrix (`admin` → read/mutate/administer · `operator` → read/mutate · `viewer` → read) is a pure unit in `internal/roles.ts`, the shape `occupancy` uses for `tenancyAccess`. **Deviation, sanctioned and recorded in `SPEC-staff.md`:** it is code and not a config row — a stated exception to SPEC.md rule 4, because an access-control matrix a database write could widen is a privilege-escalation path, and changing who may mutate must cost a deploy and leave a diff
- [x] Every staff action writes an audit record with the actor **and the role that permitted it** — `audit_log.actor_role` (`0007`), a column rather than a field inside `inputs`: `inputs` means the arguments to the command, and what permitted the actor is a different fact. Nullable and unconstrained, because tenant, agent and system actors hold no role and the kernel knows no module's vocabulary. Login and logout carry it too, which is what lets Friday's demo tell two sessions apart
- [x] Seeding gains a role; the existing seeded account becomes `admin` — the seeder creates an admin (fixed, not env-driven: a `STAFF_SEED_ROLE` that could say `viewer` deploys a system nobody can administer), and `0008` **backfills every operator that already exists**, which is the only path that reaches the account already live on staging and prod, since the seeder creates but never updates
- [x] **The gap under the bar, closed:** `staff` owned no mutating commands, so "a viewer cannot mutate" had nothing to call. It now fronts the eight the system has — `addPerson`, `addPhone`, `addBuilding`, `addUnit`, `addAsset`, `openTenancy`, `addParty`, `endTenancy` — as `internal/commands.ts`, taking `(input, session)`. The three modules arrive **through their `contract.ts` only**, injected in the constructor as 7.1 did. The check runs *inside* `audit.around` so a refusal leaves an `error` row rather than none, and *before* the module is reached so a viewer never touches domain state. A successful staff mutation therefore writes **two** audit rows, deliberately: the edge says who was allowed, the module says what changed

**Done when:** a viewer cannot mutate — proven by a test that calls the command directly, not by the UI.
**Verify:** `npm test src/staff/contract.test.ts src/staff/internal/*.test.ts src/staff/ui/*.test.ts` — *glob widened*, as in 6.1, 6.2 and 7.1: as written (`src/staff/*.test.ts`) it matched **nothing at all**, since every staff test lived under `internal/` or `ui/` · Size: M

**Verified 2026-08-24:** 43 staff tests pass (15 of them the pure role matrix, written out as the whole 3×3 grid so a fourth capability cannot be added without deciding every role's answer). *Done when* is one named test — a real logged-in viewer session refused `not_allowed` on all eight commands, with inputs that succeed for every other role, and the ids it aimed at re-counted afterwards to prove nothing moved. **The bar was checked by breaking it:** with the single `requireCapability` line removed, that test and the refusal-audit test both fail; restored, all four pass. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **236 pass, 0 skipped** (run three times, identical) · `npm run evals` → 3/3. 214 → 236. Migrations proved against the real database rather than inferred: both in `schema_migrations`, `role` reported `NOT NULL` with no default and the three-value `CHECK`, `actor_role` nullable — and the two facts that matter, **351 of 351** operators predating `0008` now reading `admin`, and **0** of the 3,522 audit rows predating `0007` carrying a role. Both files re-apply clean over an already-migrated database. Record: `tasks/evidence/day-9-roles.md`

> **Day 9 closed 2026-08-25.** Merged as [#13](https://github.com/RandomWilder/dona-v3/pull/13) (`b01b294`), CI green, and the Deploy workflow ([run](https://github.com/RandomWilder/dona-v3/actions/runs/32759810570)) carried it to staging. Confirmed on the deployed URL rather than from the workflow's own exit code: staging `/health` reports `{"ok":true,"version":"b01b294","db":"up"}` — the day-9 commit itself, not a `-dev` fallback. Prod is unchanged at `v0.1.1`, as intended: prod moves on a `v*` tag, which is 10.2's job.
>
> Open for 10.1/10.2: **the viewer account for Friday's demo cannot be created by the system.** The seeder creates but never updates, there is no operator-management screen, and `administer` is named in the matrix with no command behind it — so a second operator on staging is a manual `INSERT` today. Also: no route calls the guarded surface yet; 10.1's people and properties views are what put it behind a URL.

## Day 10 (Fri) — The board becomes usable, and the checkpoint

### Slice 10.1 — Admin people + properties views ☑
- [x] The `אנשים` and `נכסים` destinations built in 5.1 stop being empty states. **Not a UI slice, as it turned out:** the three modules exposed *no browse reads* — `portfolio` could fetch a unit by an id it gave you no way to learn, `identity` could only resolve a phone, `occupancy` could go person → place but never place → person. So `listBuildings` / `getBuilding` (portfolio), `getPeople` / `listPhones` (identity) and `findCurrentTenancy` (occupancy) came first, each on its module's contract, each specced before written. **No migration:** all three indexes these reads need already existed, checked against the schema rather than assumed
- [x] Server-rendered from the module contracts, through the guarded surface only — routes never reach a domain module directly, which is what keeps the permission check on one path. Panels became **real URLs**: a page whose content depends on which button was clicked last has no address to link, bookmark or reload, so `?panel=` would not have been "server-rendered" in any sense worth the name. No client framework and no bundler — one shell file with a `<!--main-->` marker the routes fill, the same substitution `loginPages()` has always done on the login error paragraph. The only script left is the mobile drawer toggle
- [x] **The escaper, in the kernel before the first view needed it.** This slice is the first thing in the system to put database text into markup — `routes.ts` previously held "nothing from the request is ever interpolated into the page" as a property of itself. `kernel/ui/html.ts` escapes **by default** through a tagged template with no raw escape hatch, so forgetting is impossible rather than merely discouraged; in the kernel and not in `staff` because `channel` renders tenant text in week 4, the argument that moved `requireText` in 7.1
- [x] **Two decisions taken with Asaf before the plan, both now in `SPEC-staff.md`.** *Detail reads are audited, list reads are not* — the 9.1 rule is that every staff **action** leaves a record, and the honest reading for reads is not "every page load"; what a privacy request asks is who opened **this tenant's record**, which is the detail view. *`אנשים` is a lookup, not a roster* — there is deliberately no "list every person" read, because a screen whose whole content is every tenant's personal data, unscoped and unpaginated, is a liability; people are reached through the property

**Done when:** the pilot building is browsable on staging — buildings, units, and the people in them.
**Verify:** phone screenshot of the pilot building on staging. · Size: M → L, given the reads

**Verified 2026-08-25:** the browse path is one named test — building → unit → person, each page reached only by a link the previous one rendered. **All three bars were checked by breaking them:** remove the `escapeHtml` call and 8 of 27 tests fail; remove `requireCapability` and the viewer test fails; drop the `AT TIME ZONE` from occupancy's shared `today` and **both** `findCurrentTenancy` boundary tests fail alongside `resolveByPhone`'s — which is the property reusing the one predicate was for. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **279 pass, 0 skipped** · `npm run evals` → 3/3. 236 → 279. Record: `tasks/evidence/day-10-admin-views.md`

**Run in a browser, not only in tests** — at 375px and desktop. Two real defects found that way and fixed with tests: an unlabelled asset rendered as **`boiler`**, the raw enum in English on a Hebrew ops board; and an open-ended tenancy read *"עד —"*, which looks like missing data rather than an open term. The shell footer also still said *"שלד בלבד"* — shell only — which this slice made false.

**Two corrections where the spec was wrong and the test was right**, the same way round as 7.1's timezone note: `label_key` does *not* sort `2` before `10` (it is text — a real staircase listed 1, 10, 11, 2), so the read sorts numerically and the spec was rewritten; and a TypeScript **parameter property is not erasable syntax**, which Node 24 refuses outright — AGENTS.md's "erasable syntax only" rule firing in practice.

**One unexplained test failure, recorded rather than smoothed over.** In the gate run immediately after the last `index.html` edit, one test failed; its identity was not captured and it has not recurred in **17 consecutive full runs**. The carried-in `staff` session-sweep flake below is the obvious suspect — documented as roughly one run in five — but that is a guess and is written as one.

> Open for 10.2, unchanged by this slice: **the viewer account still cannot be created by the system** — the seeder creates but never updates, and `administer` still has no command behind it. Also new and deliberate: the read guard has **no failing role**, since all three hold `read`; it exists so a fourth role cannot silently open the views, and `internal/queries.test.ts` pins the grid so that stays visible rather than reading as coverage.

### Slice 10.2 — Week 2 checkpoint ☐
- [ ] Run the week demo (top of file); tick ROADMAP week 2; write week 3's todo
- [ ] Tag `v0.2.0` → prod

**Done when:** viewer vs admin demonstrated on prod; ROADMAP week 2 fully ticked.
**Verify:** `v0.2.0` live on prod. · Size: S

---

## Carry rules
- A slice that doesn't finish moves to tomorrow **as-is** — never half-merge.
- Anything cut under pressure gets written at the bottom here, not silently dropped.
- External fuses (`tasks/fuses.md`) get a one-line status check every morning.

## Carried in from week 1
- **Domain for `app.` / `admin.`** — owed by Dona Dom, not blocking; Cloud Run URLs work. Needed when custom domains are mapped.
- **`npm audit` is not in the CI gate.** Wants its own slice; week 6's hardening is its natural home.
- **Per-service IAM scoping.** `deploy-staging` and `deploy-prod` hold `roles/run.admin` at *project* level. Both services now exist, so the binding is finally possible. Week 6.
- **The default compute service account holds `roles/editor`** on `dona-v3` — a Google default — so it can read the private document buckets regardless of their own IAM. Nothing uses it: Cloud Run runs as `app-<env>` and images build in GitHub Actions. Removing the binding is a project-wide IAM change, deliberately not made inside slice 7.0. Week 6.
- **The document store has no retention rule and no deletion path.** A signed lease is a legal record whose retention is Dona Dom's to set, not ours to guess — but a real tenant cannot yet exercise a deletion request. Week 6, with the rest of the privacy work. Also absent: CMEK and data-access audit logs.
- **Staging's blast radius changed.** It now holds real leases — government ID numbers and signature images — so it is no longer the environment that can be broken freely. This raises the price of the two items above and of staging having no alerting.
- **Prod has no alerting** beyond the smoke test and the billing budget; no PITR, no private IP/VPC connector. Week 6, all named in `docs/runbook-deploy.md`.
- **Auth items deferred deliberately** (`SPEC-staff.md`): CSP headers, per-IP rate limits, password rotation and change flow, login CSRF. Week 6.
- **Seeding creates but never updates.** Changing a live operator's password has no path yet; the rotation flow lands with week 6, and until then the runbook documents the manual route.

## Carried in from week 2
- **`staff`'s session sweep makes the test suite flaky.** `login()` and `readSession()` (`src/staff/internal/auth.ts`) each delete *every* expired session in the database using their own clock's `now`. `node --test` runs files in parallel against one database, so a test on the system clock wipes a fixed-clock test's still-valid session: `auth.test.ts:99` failed once in five gate runs and passed the other four. Found during 7.1, in a module 7.1 does not touch, so it was flagged rather than folded in. Wants `SPEC-staff.md` updated first.
- **Overlapping tenancies on one unit are not prevented in general.** `UNIQUE (unit_id, starts_on)` stops the case that matters — a re-run import creating a second copy — but two tenancies with different start dates and overlapping ranges are still insertable. The schema-level fix is an exclusion constraint over a `daterange`, which needs `btree_gist`; whether the Cloud SQL runtime user may `CREATE EXTENSION` is unverified, and finding out is its own slice rather than a guess inside 7.1.
