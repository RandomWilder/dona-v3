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
- [ ] GCP project + billing alerts; OpenAI key with budget cap; domain picked for `app.` / `admin.`

**Done when:** all four fired and logged (a note per item: date, status, who owes what).
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

### Slice 4.1 — Staging on Cloud Run ☐
- [ ] Dockerfile; Artifact Registry; Cloud Run `staging` service; Cloud SQL (`app_staging`) connected; Secret Manager wired
- [ ] GitHub Actions deploy on merge-to-main via Workload Identity Federation (no long-lived keys)
- [ ] Migrations apply on deploy; `/health` green on the staging URL

**Done when:** merge to main → staging updates itself, end to end, no manual step.
**Verify:** merge a trivial change, watch it land. · Size: M

### Slice 4.2 — Prod + rollback rehearsed ☐
- [ ] Cloud Run `prod` service (min instances 1) + `app_prod` DB; deploy on git tag
- [ ] Rollback = one documented command (previous revision); **rehearse it once on purpose**
- [ ] Smoke step in the deploy job: `/health` must pass or the deploy fails loudly

**Done when:** you have deployed AND rolled back prod today, both on purpose.
**Verify:** Cloud Run revision history shows the round-trip. · Size: S

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
_(empty — add items here as reality hits)_
