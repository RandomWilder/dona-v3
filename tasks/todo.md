# Week 2 — Identity, portfolio, occupancy, roles

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployed. Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** the real pilot building lives in the system; staff access is role-gated and audited.
**Week demo (Friday):** log in as viewer and as admin — different powers, proven by a test rather than by hidden buttons; the audit trail shows both sessions; the pilot building is browsable on staging.

Previous week: `tasks/week-1.md` (closed — `v0.1.0` live on prod behind a login).

---

## Day 6 (Mon) — The two independent modules

### Slice 6.1 — `identity`: people, phones, roles ☐
- [ ] Migration + `SPEC-identity.md` written **before** the code: person, phone (E.164, normalised), person-kind (tenant / vendor / staff — a person can be more than one)
- [ ] Commands through `contract.ts` only: `addPerson`, `addPhone`, `findByPhone`. Idempotent on business intent, audited, validated at the edge
- [ ] Phone normalisation is its own tested unit: Israeli numbers arrive as `050-…`, `+9725…`, `9725…` and must resolve to one person

**Done when:** a phone number in any of the three formats resolves to the same person; a second `addPerson` with the same intent key returns the first result.
**Verify:** `npm test src/identity/*.test.ts` · Size: M

### Slice 6.2 — `portfolio`: buildings, units, assets ☐
- [ ] `SPEC-portfolio.md`, then migration: building, unit, asset (boiler, lift, intercom…), access notes
- [ ] Commands: `addBuilding`, `addUnit`, `addAsset`, `getUnit`. No dependency on identity — portfolio is about places, not people

**Done when:** contract tests cover the tree building → unit → asset, and a unit cannot be created under a building that does not exist.
**Verify:** `npm test src/portfolio/*.test.ts` · Size: M

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
