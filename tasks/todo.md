# Week 1 — Walking Skeleton in Production

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployable (from day 4: deployed). Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** `git push` → live URL, both deploy directions proven, styled shells online. No features.
**Week demo (Friday):** open the prod URL on your phone → styled Hebrew shell loads; break a test → PR blocked; rollback → previous version live in one command.

---

## Day 1 (Mon) — Repo, context layer, external fuses

### Slice 1.1 — Light the external fuses ☐
Everything with a lead time you don't control, fired before writing code.
- [ ] Meta WhatsApp Business verification started (longest fuse)
- [ ] SMS provider account created (Twilio first choice); one test OTP sent to your own Israeli number
- [ ] Data request sent to Dona Dom: lease PDFs, tenant↔unit↔phone table, vendor list, deductible rules, fault Q&A doc
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

### Slice 2.1 — Database up, migrations real ☐
- [ ] `docker compose up` → Postgres 16 + pgvector locally
- [ ] Migration runner (ordered `.sql` files, applied-migrations table, idempotent re-run)
- [ ] Migration 0001 (kernel tables), `npm run dev` serves `/health` with version + db check

**Done when:** clean clone → running app in under 5 minutes, documented in AGENTS.md.
**Verify:** delete the clone, re-clone, time it. · Size: M

### Slice 2.2 — Kernel core: error shape, ids, clock ☐
- [ ] One error shape (machine code, human message, details) used by every handler
- [ ] Id generation + injectable clock (tests never sleep or call `Date.now` directly)
- [ ] Contract tests for both

**Done when:** the 5 error categories from the SRS render through one type; tests green.
**Verify:** `npm test src/kernel` · Size: S

## Day 3 (Wed) — Kernel durability + CI gate

### Slice 3.1 — Idempotency, audit, durable work ☐
- [ ] Idempotency store keyed on business intent (retried command returns first result — proven by test)
- [ ] Audit log: every command writes actor + action + inputs + outcome
- [ ] Outbox + durable work runner on Postgres (timers survive restart — test kills and restarts)

**Done when:** the three tests above green; patterns match dona-v2's kernel (reference, not copy-paste).
**Verify:** `npm test src/kernel` incl. restart test. · Size: M

### Slice 3.2 — CI gate + eval stub ☐
- [ ] `ci.yml`: typecheck + lint + tests on every PR; red blocks merge
- [ ] `evals/` runner stub + 3 trivial golden cases wired into CI (the gate exists from commit one)
- [ ] Prove it: open a PR with a broken test → blocked; fix → merges

**Done when:** the broken-PR screenshot exists; evals job runs (even if trivially).
**Verify:** the deliberately-broken PR in repo history. · Size: S

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
