# Week 1 — Walking Skeleton in Production

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployable (from day 4: deployed). Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** `git push` → live URL, both deploy directions proven, styled shells online. No features.
**Week demo (Friday):** open the prod URL on your phone → styled Hebrew shell loads; break a test → PR blocked; rollback → previous version live in one command.

---

## Day 1 (Mon) — Repo, context layer, external fuses

### Slice 1.1 — Light the external fuses ☐
Everything with a lead time you don't control, fired before writing code. Live status per fuse: `tasks/fuses.md`.
- [x] Meta WhatsApp Business verification started (longest fuse)
- [x] SMS provider account created (Twilio first choice); one test OTP sent to your own Israeli number
- [x] Data request sent to Dona Dom: lease PDFs, tenant↔unit↔phone table, vendor list, deductible rules, fault Q&A doc (sent + acknowledged 2026-08-22 — docs arriving by apartment, phones included)
- [x] GCP project + billing alerts (₪500/mo, alerting 50/90/100%) ✓ · OpenAI key with budget cap ✓ — **proven in anger by slice 4.1**, which provisioned and deployed on this project
- [ ] Domain picked for `app.` / `admin.` — **owed by Dona Dom**, not blocking: staging runs on the Cloud Run `*.run.app` URL. Needed only when custom domains are mapped (5.x / production polish)

**Done when:** all four fired and logged (a note per item: date, status, who owes what). — three closed; only the Dona Dom domain is outstanding.
**Verify:** the test SMS arrived on your phone. · Size: S (no code)

### Slice 1.2 — Repo + agent context layer ✔
- [x] `git init`, GitHub repo (RandomWilder/dona-v3), branch protection on `main` (no force-push/deletion; required CI check added day 3 with ci.yml)
- [x] `AGENTS.md` (≤30 lines: commands, style, architecture map) + `CLAUDE.md` pointer
- [x] `SPEC.md` with the 8 foundation rules; empty `SPEC-<module>.md` stubs (11 modules)
- [x] `.claude/settings.json`: permissions allowlist + hooks (format+test after write via `after-write.mjs`, block-dangerous-bash via `guard-bash.mjs`, session-start status)
- [x] `.cursor/rules/`: ui-tokens rule, module-boundaries rule, migrations rule
- [x] `tsconfig` + Biome + `node --test` wired; dummy kernel test green (typecheck ✓ lint ✓ test ✓)

**Done when:** fresh Claude Code session reads AGENTS.md and can state the build/test commands; `npm test` green.
**Verify:** `npm run typecheck && npm test` · Size: M

## Day 2 (Tue) — Local runtime + kernel core

### Slice 2.1 — Database up, migrations real ✔
- [x] `docker compose up` → Postgres 16 + pgvector locally (pgvector/pgvector:pg16, host port 5434)
- [x] Migration runner (ordered `.sql` files, applied-migrations table, idempotent re-run — proven by test + double dev run)
- [x] Migration 0001 (enables pgvector; kernel *tables* land with their contract tests in 3.1), `npm run dev` serves `/health` with version + db check (503 + error shape when db down)

**Done when:** clean clone → running app in under 5 minutes, documented in AGENTS.md. ✔
**Verify:** delete the clone, re-clone, time it. · **Verified 2026-08-22: fresh GitHub clone → npm ci → db up → `/health` ok in 6 seconds** (warm docker image + npm cache; cold machine adds the ~100MB image pull, still far under 5 min). · Size: M

### Slice 2.2 — Kernel core: error shape, ids, clock ✔
- [x] One error shape (machine code, human message, details) used by every handler (`KernelError` + `toErrorBody` + `httpStatus`; `/health` 503 and `createPool` now render through it)
- [x] Id generation + injectable clock (UUIDv7 from injected clock; `fixedClock` test double — no sleeps, no `Date.now` in logic)
- [x] Contract tests for both

**Done when:** the 5 error categories from the SRS render through one type; tests green. ✔
**Verify:** `npm test src/kernel/*.test.ts` (Node 24's `node --test` needs file paths, not a bare directory) · **Verified 2026-08-22: 16 kernel tests green; full gate typecheck ✓ lint ✓ 18/18 tests ✓** · Size: S

## Day 3 (Wed) — Kernel durability + CI gate

### Slice 3.1 — Idempotency, audit, durable work ✔
- [x] Idempotency store keyed on business intent (retried command returns first result; concurrent duplicate → `conflict`; failed command stays retryable; stale claim reclaimable)
- [x] Audit log: `around()` records actor + action + inputs + outcome on both success and failure, then re-throws
- [x] Outbox + durable work runner on Postgres (drivable `tick()`, `FOR UPDATE SKIP LOCKED`, exponential backoff; restart proven by a fresh runner picking up work a discarded one scheduled)

**Done when:** the three tests above green; patterns match dona-v2's kernel (reference, not copy-paste). ✔ — v2 read as reference; 5 deliberate divergences recorded in `SPEC-kernel.md` §Decisions (Postgres-only, no sleeps anywhere, clock as a bound SQL parameter, explicit `state` column, failed commands release their key).
**Verify:** `npm test src/kernel/*.test.ts` incl. restart test. · **Verified 2026-08-22: 32 kernel tests green (incl. restart + two-runner race); full gate typecheck ✓ lint ✓ 34/34 ✓; migration 0002 applied via `npm run dev`, `/health` ok, all four tables present** · Size: M

### Slice 3.2 — CI gate + eval stub ✔
- [x] `ci.yml`: typecheck + lint + tests on every PR against a `pgvector/pg16` service; `gate` + `evals` required on `main` (closes the required-check item left open in 1.2)
- [x] Carried from 3.1 — handled: `REQUIRE_POSTGRES=1` turns an unreachable database from a skip into an `unavailable` failure, so CI cannot report green having run none of the durability suite. Local runs still skip. Both branches tested.
- [x] `evals/` runner stub + 3 golden cases wired into CI; grades behaviour (tool called, clause cited, refusal), not final text. Subject is an explicit placeholder until the channel agent (week 3) — so `runner.test.ts` grades a wrong subject and asserts the run comes back red.
- [x] Proved it: PR #1 green, PR #2 deliberately broken → `gate` red, merge blocked

**Done when:** the broken-PR screenshot exists; evals job runs (even if trivially). ✔ — evidence is `tasks/evidence/3.2-broken-pr.md` (check results + GitHub's own merge state) rather than a screenshot; `mergeStateStatus: BLOCKED` with `mergeable: MERGEABLE` is stronger proof than a picture of a red tick.
**Verify:** the deliberately-broken PR in repo history. · **Verified 2026-08-22: [PR #2](https://github.com/RandomWilder/dona-v3/pull/2) closed unmerged — `gate` red on a 409→200 break, merge blocked by the required check; [PR #1](https://github.com/RandomWilder/dona-v3/pull/1) green with `tests 40 / pass 40 / skipped 0`, so the durability suite ran for real in CI** · Size: S

## Day 4 (Thu) — Deploy pipeline, both directions

### Slice 4.1 — Staging on Cloud Run ✔
- [x] Dockerfile (`node:24-slim`, no build step); Artifact Registry `dona`; Cloud Run `dona-staging`; Cloud SQL `dona-staging` (POSTGRES_16, db-f1-micro, **me-west1** so tenant data stays in Israel); connection URL in Secret Manager, mounted as `DATABASE_URL`
- [x] Deploy on merge-to-main via Workload Identity Federation — no long-lived keys. Provider pins `assertion.repository` to this repo; runtime and deploy service accounts are separate and least-privilege
- [x] Migrations apply on deploy (`boot.ts` awaits `migrate()` before `listen()`, so a bad migration fails the deploy instead of serving); `/health` green on the staging URL

**Done when:** merge to main → staging updates itself, end to end, no manual step. ✔
**Verify:** merge a trivial change, watch it land. · **Verified 2026-08-22: push `03f1130` → [CI green](https://github.com/RandomWilder/dona-v3/actions/runs/32595090848) → [Deploy green](https://github.com/RandomWilder/dona-v3/actions/runs/32595116241) → https://dona-staging-ydabrrmura-zf.a.run.app/health returns `{"ok":true,"version":"0.1.0-dev","db":"up"}` in 0.44s, revision `dona-staging-00001-vkx` on image tag `03f1130…`. No manual step. Cloud Run logs clean; pgvector accepted by Cloud SQL.** · Size: M

> Findings worth keeping: me-west1 defaults new Cloud SQL instances to `ENTERPRISE_PLUS`, which rejects shared-core tiers — `--edition=ENTERPRISE` is required for db-f1-micro. Deploy triggers on *CI succeeding*, not on push, so a red commit cannot reach staging even though `enforce_admins` is off.

### Slice 4.2 — Prod + rollback rehearsed ✔
- [x] Cloud Run `dona-prod` (min instances 1 / max 5) + its **own** Cloud SQL instance `dona-prod` (backups 02:00 UTC, 7 retained) — not a second database on staging's, per `docs/decisions/ADR-0001-prod-database-isolation.md`; ROADMAP's architecture table amended. Deploy on `v*` tag via `release.yml`, which re-runs the full CI gate on the tagged commit (tags don't match ci.yml's push filter, so `workflow_call` is what makes a tag mean anything) and refuses tags that aren't ancestors of `main`
- [x] Rollback = `./infra/rollback.sh <staging|prod>` — previous ready revision, traffic moved, smoke run against it. **Rehearsed on staging first, then on prod: 10 seconds.** Documented in `docs/runbook-deploy.md`
- [x] `infra/smoke.sh` — one definition of "up" for both workflows and for humans; requires `db:up` as well as `ok:true`, and proven to exit non-zero on a bad target, so a deploy fails loudly rather than passing quietly
- [x] Carried out of 4.1's baseline: `infra/staging-bootstrap.sh` → `infra/bootstrap.sh <staging|prod>`, so two environments cannot drift. Re-run against live staging before prod: clean no-op

**Done when:** you have deployed AND rolled back prod today, both on purpose. ✔
**Verify:** Cloud Run revision history shows the round-trip. · **Verified 2026-08-23: `dona-prod-00001-c8s` (tag [v0.0.1-rc.1](https://github.com/RandomWilder/dona-v3/actions/runs/32627131362)) → `00002-dwz` (tag [v0.0.1-rc.2](https://github.com/RandomWilder/dona-v3/actions/runs/32627283545)) → **rolled back to `00001-c8s` in 10s** → rolled forward to `00002-dwz`. https://dona-prod-ydabrrmura-zf.a.run.app/health returns `{"ok":true,"version":"0.1.0-dev","db":"up"}`; prod logs clean, migrations applied on the fresh instance. Full record: `tasks/evidence/4.2-prod-rollback.md`** · Size: S

> Findings worth keeping: a rollback **pins** traffic — the next `gcloud run deploy` then creates a revision serving 0%, a green pipeline that changes nothing. Both workflows now end with `--to-latest`. Caught by rehearsing the rollback on staging before prod, which is the only reason `deploy.yml` got the fix too; proven by leaving staging deliberately pinned and watching the merge un-pin it. Also: a tag is invisible to a branch-filtered CI workflow, so a release pipeline can look gated and not be.

## Day 5 (Fri) — Shells, auth stub, checkpoint

### Slice 5.1 — Presentation shell (Hebrew RTL) ☐
- [ ] `tokens.css` ported from dona-v2 (fonts self-hosted, RTL logical properties)
- [ ] Admin shell page (chrome sidebar, empty nav destinations) + widget shell page (chat frame, dead composer)
- [ ] Served by the app at `/admin` and `/t/:link` — live on staging

**Done when:** both shells load on your phone from the staging URL, styled, RTL-correct.
**Verify:** phone screenshot. · Size: M

### Slice 5.2 — Staff login stub + Friday checkpoint ☐
- [ ] Email+password session login (argon2) gating `/admin` — one seeded admin user, roles come week 2
- [ ] Week 1 checkpoint ritual: run the week demo (top of file), tick ROADMAP.md week 1, write week 2's todo
- [ ] Tag `v0.1.0` → prod

**Done when:** prod URL shows the login page; wrong password fails; ROADMAP week 1 fully ticked.
**Verify:** `v0.1.0` live on prod. · Size: S

---

## Carry rules
- A slice that doesn't finish moves to tomorrow **as-is** — never half-merge.
- Anything cut under pressure gets written at the bottom here, not silently dropped.
- External fuses (1.1) get a one-line status check every morning.

## Cut / carried this week
- **`npm audit` is not in the CI gate** (noticed during 4.2 against the shipping checklist — a dependency audit belongs before a production launch). Not smuggled into 4.2; wants its own slice, and week 6's hardening is its natural home.
- **Per-service IAM scoping.** `deploy-staging` and `deploy-prod` hold `roles/run.admin` at *project* level, so today they differ in audit trail rather than in power. Scoping to each service can only be bound after the service exists — both now do. Week 6.
- **Prod has no alerting** beyond the smoke test and the billing budget; no PITR, no private IP/VPC connector. All week 6, all named in `docs/runbook-deploy.md` under "Not yet in place".
