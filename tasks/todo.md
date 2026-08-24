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

**Verified 2026-08-23:** 42 identity tests pass (33 normalisation + 9 contract). Both halves of *Done when* are named tests: four spellings of one number resolve to one person id, and a repeated `intentKey` returns the first result with exactly one row in `identity_people`. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **118 pass, 0 skipped** · `npm run evals` → 3/3. Migration proved against the real database rather than inferred: `0004_identity.sql` in `schema_migrations`, `identity_phones_pkey` on `phone`, and no `DEFAULT now()` on any `created_at` — a test asserts the stored time is the injected clock's.

### Slice 6.2 — `portfolio`: buildings, units, assets ☑
- [x] `SPEC-portfolio.md`, then migration: building, unit, asset (boiler, lift, intercom…), access notes. `0005_portfolio.sql`. **Deviation, sanctioned:** an asset names its building always and its unit *optionally* — `unit_id IS NULL` is a building asset, so a lift is the building's rather than whichever flat it was parked under. A composite FK `(unit_id, building_id)` makes pairing a unit with the wrong building impossible
- [x] Commands: `addBuilding`, `addUnit`, `addAsset`, `getUnit`. No dependency on identity — portfolio is about places, not people. **No intent keys anywhere in this module:** a place has natural identity (a building *is* its address, a unit *is* its label within one), so all three creates are idempotent on unique indexes and the kernel's `once()` is unused here — the contrast with `identity` is recorded in both specs
- [x] Access notes are opt-in on the read (`getUnit(id, { includeAccessNotes: true })`) — they are entry codes, and a caller must ask rather than remember to strip
- [x] Key normalisation is its own tested unit (`internal/keys.ts`, 12 cases), deliberately naive: whitespace and case, plus leading zeros on numeric unit labels. It does **not** know `רח׳` is `רחוב` — real addresses arrive day 8, and a wrong guess merges two real buildings

**Done when:** contract tests cover the tree building → unit → asset, and a unit cannot be created under a building that does not exist.
**Verify:** `npm test src/portfolio/*.test.ts src/portfolio/internal/*.test.ts` — *glob widened*, as in 6.1: as written it missed `internal/keys.test.ts` · Size: M

**Verified 2026-08-23:** 23 portfolio tests pass (12 key normalisation + 11 contract). Both halves of *Done when* are named tests: the tree is written and read back whole through `getUnit`, and a unit under an unknown building is refused `not_found`. Full CI gate run locally as CI runs it — `npm run typecheck` · `npm run lint` · `REQUIRE_POSTGRES=1 npm test` → **141 pass, 0 skipped** · `npm run evals` → 3/3. Migration proved against the real database: `0005_portfolio.sql` in `schema_migrations`, the composite FK `portfolio_assets_unit_id_building_id_fkey` present, and the unique constraint reported by Postgres as `NULLS NOT DISTINCT` — which is what makes two building assets of one kind collide instead of duplicating.

> **Day 6 closed.** Both modules exist and neither imports the other. 7.1 joins them.

## Day 7 (Tue) — The join that the whole product rests on

### Slice 7.1 — `occupancy`: who lives where, who is billed ☐
- [ ] `SPEC-occupancy.md` first: current lease, tenant(s), the billed party, start/end. Depends on identity + portfolio, via their contracts only
- [ ] `resolveByPhone(phone)` — the chain the agent will call on every conversation: phone → person → unit → **current** occupancy
- [ ] Isolation test: a phone belonging to one tenancy must not resolve to another's unit, and an ended occupancy must not resolve at all

**Done when:** `phone → person → unit → current occupancy` resolves end to end, and the isolation test proves it cannot cross tenancies.
**Verify:** `npm test src/occupancy/*.test.ts` · Size: M

> This is the seam SPEC.md's "absolute tenant isolation enforced at the query layer" hangs on. Every read in weeks 3–5 is scoped by what this returns, so it gets isolation tests before it gets features.

## Day 8 (Wed) — Real data in

### Slice 8.1 — CSV importer for the tenant mapping table ☐
- [ ] Idempotent and re-runnable: importing the same file twice changes nothing the second time
- [ ] Reports rejects rather than failing the run — a bad row names itself, the good rows land
- [ ] Dry-run mode, because the first run against real data should be readable before it is committed

**Done when:** the real pilot slice imports; re-running is a no-op; 5 spot-checks against the source document pass.
**Verify:** import the real file into staging, then 5 manual `resolveByPhone` lookups. · Size: M

> **Depends on Dona Dom.** Lease PDFs and the tenant↔unit↔phone table were requested and acknowledged 2026-08-22 (`tasks/fuses.md`). If the data has not arrived by Wednesday this slice slips and Day 9 moves up — the importer can be built against a synthetic file, but it cannot be *verified* against one.

## Day 9 (Thu) — Roles on top of the login

### Slice 9.1 — admin / operator / viewer ☐
- [ ] Roles on `staff_operators`, checked **server-side per command** — never by hiding a button
- [ ] Every staff action writes an audit record with the actor and the role that permitted it
- [ ] Seeding gains a role; the existing seeded account becomes `admin`

**Done when:** a viewer cannot mutate — proven by a test that calls the command directly, not by the UI.
**Verify:** `npm test src/staff/*.test.ts`, including a viewer attempting each mutating command and being refused `not_allowed`. · Size: M

## Day 10 (Fri) — The board becomes usable, and the checkpoint

### Slice 10.1 — Admin people + properties views ☐
- [ ] The `אנשים` and `נכסים` destinations built in 5.1 stop being empty states: list + create, Hebrew RTL, tokens only
- [ ] Server-rendered from the module contracts; no client framework, no bundler

**Done when:** the pilot building is browsable on staging — buildings, units, and the people in them.
**Verify:** phone screenshot of the pilot building on staging. · Size: M

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
- **Prod has no alerting** beyond the smoke test and the billing budget; no PITR, no private IP/VPC connector. Week 6, all named in `docs/runbook-deploy.md`.
- **Auth items deferred deliberately** (`SPEC-staff.md`): CSP headers, per-IP rate limits, password rotation and change flow, login CSRF. Week 6.
- **Seeding creates but never updates.** Changing a live operator's password has no path yet; the rotation flow lands with week 6, and until then the runbook documents the manual route.
