# Phase 1 Roadmap — Dona Dom Tenancy OS

8 weeks · solo build (Claude Code + Cursor) · deployed and live on real pilot data at week 8.

> The living plan — check boxes, move cut-line items, re-plan every Friday. The vision it builds toward: the **Dona Dom Experience Mockups** canvas (Thread + Command Room), the Product Vision doc, and the SRS. dona-v2 is pattern reference only — steal, don't fork.

---

## Definition of Live (week 8 exit — the bar)

- [ ] A real tenant, over the **web widget**, verifies (OTP to number-on-record, fail-closed) and gets a **cited answer from their own lease** — on production.
- [ ] A real fault goes **intake → self-service gate → deductible consent → vendor offer → first-accept → scheduled visit → sign-off** with zero staff touches; every step audited.
- [ ] Admin panel live with **roles enforced** (admin / operator / viewer), single intake queue with SLA timers, full transcripts with the agent's cited sources, staff takeover, and per-capability **kill switches**.
- [ ] **Zero cross-tenant leakage** — enforced at the query layer, proven by tests that actively try.
- [ ] Pipeline: PR checks (typecheck, tests, **agent golden set**) → one-command deploy → one-command rollback. Monitoring alerts reach your phone.
- [ ] WhatsApp: Meta verification in flight or approved; channel adapter boundary ready either way.

## Foundation rules (what "easy to change" means, concretely)

These are the invariants that make every future pivot cheap. Violating one to ship a week faster is how Phase 2 becomes a rewrite. Port them from dona-v2's `SPEC.md` into the new repo's `SPEC.md` on day 1:

1. **Modular monolith, one deployable.** Modules = bounded contexts (`identity`, `portfolio`, `occupancy`, `catalog`, `vendor-roster`, `case`, `job`, `dispatch`, `fulfillment`, `channel`, `staff`). A module exposes commands + events; nothing imports another module's internals.
2. **The agent is a client, not a brain.** It acts only through documented module commands (tool-calling); every call is audited. Swapping models, prompts, or channels never touches business logic.
3. **Channel is an adapter.** Widget first, WhatsApp drops in behind the same interface. Voice someday, same seam.
4. **Policies are data.** Deductibles, who-pays, SLA thresholds, offer timeouts, quiet hours, emergency definitions, kill switches — rows in config tables, editable in admin, never constants in code.
5. **One error shape, idempotency on business intent** (job id, offer id — not "retry #2"), durable timers/outbox on Postgres. A retried webhook never double-creates anything.
6. **One presentation system.** `tokens.css` + self-contained HTML per screen, no bundler. The widget and admin share the token layer (port from dona-v2, it's proven RTL-correct).
7. **Money is read-only.** The system records consents and drafts; it never bills or charges. Structural, permanent.
8. **Specs gate code.** `SPEC-<module>.md` per module; Claude Code reads the spec before touching the module. Contract tests + the golden set run in CI and block merges.

## Stack (locked — stop re-deciding)

| Layer | Choice |
|---|---|
| Runtime | Node 24 + TypeScript (type stripping), `node --test`, Biome |
| HTTP | Fastify, handlers kept thin (routing/validation only — swap stays cheap) |
| DB | Cloud SQL Postgres 16 + pgvector — **one instance per environment** (`dona-staging`, `dona-prod`), database `dona` on each; migrations run on deploy. Amended in slice 4.2: `docs/decisions/ADR-0001-prod-database-isolation.md` |
| AI | OpenAI: tool-calling chat model + `text-embedding-3-large`; model ids live in config (policy-as-data), never inline |
| Files | GCS bucket (lease PDFs, photos, evidence) |
| Deploy | GitHub Actions → Artifact Registry → Cloud Run (`staging` on merge to main, `prod` on tag). Secret Manager for keys. Min instances: 0 staging / 1 prod |
| Monitoring | Structured JSON logs → Cloud Logging + Error Reporting; uptime check + alert policy → email/SMS |
| SMS/OTP | Twilio Verify (confirm Israeli deliverability week 1; fallback: InforU/019 via thin `sms` adapter) |
| UI | No-build HTML + shared `tokens.css` (Heebo / IBM Plex Mono, RTL logical properties) |

## Fire on day 1 (external lead times you don't control)

- [ ] Meta **WhatsApp Business** verification + phone number (longest fuse — start before writing code)
- [ ] SMS provider account + Israeli sender registration; send yourself one OTP
- [ ] Request pilot data from Dona Dom: lease PDFs + tenant↔unit↔phone table + vendor list + deductible rules + fault Q&A doc
- [ ] GCP project, billing alerts, Cloud SQL + GCS provisioned; OpenAI org key with budget cap
- [ ] Domain + TLS for widget and admin (`app.…`, `admin.…`)

---

## Week 1 — Walking skeleton in production

**Goal: `git push` → live URL. Foundation + pipeline before any feature.**

- [ ] New repo scaffold: kernel first — error shape, ids, clock, migration runner, idempotency store, audit log, event outbox, durable work runner (port patterns from dona-v2 `src/kernel/`). **Done when:** kernel contract tests green.
- [ ] Local dev: docker compose Postgres 16 + pgvector; `npm run dev` serves health page. **Done when:** clean clone → running in <5 min.
- [ ] CI: typecheck + tests + lint on every PR; red blocks merge. **Done when:** a deliberately broken PR can't merge.
- [ ] CD: merge→staging, tag→prod on Cloud Run; migrations apply on deploy; documented one-command rollback (`./infra/rollback.sh prod`, traffic to the previous revision). **Done when:** you've deployed and rolled back once, on purpose.
- [ ] Port `tokens.css` + page shells (admin chrome, widget shell); staff login stub behind sessions. **Done when:** styled Hebrew RTL "shell" pages live on staging.
- [ ] `SPEC.md` + empty `SPEC-<module>.md` files committed (contracts sketched, one page each).

**Checkpoint demo:** phone opens the prod URL, sees the styled shell. CI/CD proven both directions.
**Cut line:** nothing. This week is the foundation; don't trim it.

## Week 2 — Identity, portfolio, staff auth & roles

**Goal: the real pilot building lives in the system; staff access is role-gated and audited.**

- [ ] Modules `identity` / `portfolio` / `occupancy`: schemas, commands, contract tests. **Done when:** phone → person → unit → current occupancy resolves.
- [ ] CSV importer for the tenant mapping table (idempotent, re-runnable, reports rejects). **Done when:** real pilot slice imported; 5 spot-checks pass.
- [ ] Staff auth: email+password (argon2), server sessions, roles **admin / operator / viewer**; permission checks server-side per command; every staff action writes an audit record. **Done when:** viewer can't mutate — proven by test, not by hidden buttons.
- [ ] Admin shell: nav (queue · conversations · approvals · reports · properties · people · guidance) + people/properties list & create views. **Done when:** the pilot building is browsable on staging.

**Checkpoint demo:** log in as viewer vs admin — different powers; audit trail shows both sessions.
**Cut line:** approvals + reports nav items can be dead links this week.

## Week 3 — Lease ingestion & grounded answers (API-level)

**Goal: a real lease answers questions with clause citations — before any tenant UI exists.**

- [ ] Lease upload from admin → GCS, attached to an occupancy; ingest pipeline: text extraction, clause-aware chunking, embeddings → pgvector (scoped by occupancy). **Done when:** a real pilot lease is fully indexed.
- [ ] Digital-twin extraction: end date, rent, deposit/guarantees, notice periods, deductible clauses → structured fields, each traceable to its source clause; admin review screen to confirm/correct. **Done when:** one real lease's fields reviewed and confirmed.
- [ ] Guidance docs (company policy) upload + same pipeline; retrieval API ranks **this occupancy's lease → policy → refuse**. **Done when:** an off-lease question returns "unknown + escalate", never an invention.
- [ ] **Golden set v1 in CI (~30 real-style Hebrew questions):** grounding, refusal, isolation (asks about another tenant's lease must fail). **Done when:** it gates merges.

**Checkpoint demo:** curl the internal answer endpoint with a real lease question → Hebrew answer + clause citation.
**Cut line:** OCR for scanned PDFs (log as manual-entry fallback); extraction review UI can be rough.

## Week 4 — Tenant widget + agent loop v1

**Goal: first live tenant value — verified chat answering from their own lease.**

- [ ] Widget: mobile-first chat page + embeddable snippet; entry via signed link; **SMS OTP** step-up (code only to number-on-record; unknown number → callback offer, zero disclosure); session expiry. **Done when:** your own phone verifies; a wrong number gets nothing.
- [ ] Agent loop: OpenAI tool-calling over module commands only (`answer_from_lease`, `get_my_occupancy`, `open_callback`, …); Hebrew tone per spec (calm, cited, no legal interpretation, AI disclosure + recording notice at first contact). **Done when:** golden set passes through the real loop, not just the retrieval API.
- [ ] Citations rendered as chips in the thread; conversations persisted; callback requests created on request/uncertainty.
- [ ] Admin **conversations** view: transcript, the agent's cited sources per answer, staff takeover (staff message lands in tenant thread, agent pauses). **Done when:** takeover round-trips on staging.

**Checkpoint demo (milestone): real lease question, real phone, staging, end-to-end with citation.**
**Cut line:** attention-contract opt-in message (default to status+obligations silently); English localization (Hebrew only until week 7).

## Week 5 — Cases, catalog, self-service gate, the queue

**Goal: a fault becomes a managed case; the office sees one queue.**

- [ ] `catalog` module: job types, self-service how-to guides, deductible/who-pays rules, emergency flags — all rows, all editable in admin guidance. **Done when:** changing a deductible needs no deploy.
- [ ] `case` module: intake from the agent (classification: contract / payment / fault / docs / representative), priority, status; photos attached via widget upload → GCS.
- [ ] Guided diagnosis + **self-service gate**: agent walks the catalog how-to before any job is created; resolution closes the case as zero-touch. **Done when:** the water-heater-switch flow from the mockups runs.
- [ ] **Deductible consent as a recorded event** (amount + clause + timestamp) before scheduling proceeds.
- [ ] Admin **single intake queue**: classification chip, priority marker, building/unit, department filter, SLA timers vs config thresholds. **Done when:** an overdue item is visually loud.

**Checkpoint demo:** fault in widget → gate attempt → consent → case sits in the queue with a ticking SLA.
**Cut line:** SLA escalation actions (timers visible, escalation next week); photo diagnosis by vision model (store photos, human-readable only).

## Week 6 — Dispatch & scheduling (the vendor loop)

**Goal: the mockups' 11-PM-water-heater moment, minus nothing: first-accept to signed-off visit.**

- [ ] `vendor-roster`: vendors, trades, phones. `job`: priced work from a case (posted rate from catalog).
- [ ] `dispatch`: offers to matching vendors — SMS with a **signed vendor link** → offer page (issue, window, address) → **first valid accept wins** (race-safe, contract-tested: two accepts, one winner); others auto-close; timeout → staff exception (durable timer). **Done when:** race + timeout tests green.
- [ ] Tenant availability windows collected in-thread before the offer; on accept: visit scheduled, tenant gets proactive confirmation, vendor gets ICS attachment. (Calendly mirror deferred — the seam exists.)
- [ ] `fulfillment`: vendor uploads evidence via the same signed page; tenant sign-off in thread closes the case; no-show → back to dispatch or exception.
- [ ] Proactive status pushes wired for every state change (quiet hours from config).

**Checkpoint demo (milestone): full loop on staging with a friendly "vendor" (your second phone) — zero staff touches, everything audited.**
**Cut line:** no-show automation (manual re-dispatch button suffices); vendor evidence upload (photo by SMS to staff as fallback).

## Week 7 — Hardening, monitoring, drafts on exceptions

**Goal: boringly reliable. The week that makes week 8 safe.**

- [ ] Exceptions carry the agent's **draft resolution + cited sources**; approve-and-send / edit / take-over from the queue (the Command Room mockup's core interaction). **Done when:** an edited draft reaches the tenant and the edit is logged as training signal.
- [ ] Security pass: permission audit on every command, PII-safe logging (no phones/IDs in logs), rate limits on widget + OTP endpoints, signed-link expiry review. Run a structured security review over auth, isolation, and webhook surfaces. **Done when:** findings fixed or explicitly accepted in writing.
- [ ] **Kill switches** per capability (answers / faults / dispatch / proactive) — config flags falling back to "collect + callback". **Done when:** flipping one off mid-conversation degrades gracefully.
- [ ] Monitoring: Error Reporting wired, uptime checks + alert policy to your phone; nightly Cloud SQL backups + PITR verified by an actual restore to a scratch DB. **Done when:** you've been paged by a forced error and restored a backup once.
- [ ] Reports v1 in admin: zero-touch rate, volumes by topic/building, escalation reasons. Golden set doubled from real week 4–6 transcripts.
- [ ] English localization of tenant-facing strings (per-person language field already in identity).

**Checkpoint demo: chaos hour** — kill OpenAI key, kill DB connection, flood OTP endpoint: honest degradation, alerts fire, nothing corrupts.
**Cut line:** reports v1 (a SQL notebook is acceptable); English (Hebrew-only pilot is acceptable if Dona agrees).

## Week 8 — Pilot go-live on real data

**Goal: live, real tenants, real building. Buffer is the feature.**

- [ ] Onboard the pilot building completely: all leases ingested + field-reviewed, registry spot-verified (call 5 tenants' numbers), real vendor roster loaded, deductible rules confirmed with Dona Dom.
- [ ] UAT day: scripted real cases with 2–3 friendly tenants + one staff member on the admin panel; burn the fix list down same-week.
- [ ] Runbook: deploy, rollback, kill switches, backup restore, "agent said something wrong" procedure (correct → golden set → done).
- [ ] Production go-live: signed links sent to pilot tenants, widget embedded on the Dona site, alerts armed.
- [ ] **Stretch only:** WhatsApp adapter behind the channel seam (if Meta approved); Calendly mirror.

**Checkpoint: the Definition of Live at the top — every box.**

---

## Operating rhythm (vibe-coder cadence)

- **Vertical slice per day**, deployed to staging by end of day. If a task can't finish in half a day, split it before starting — Claude Code performs best on S/M tasks with written acceptance criteria.
- **Spec before code:** update the module's `SPEC-*.md` first, then point Claude Code at it. The spec is the prompt.
- **CI is the reviewer:** never merge red; the golden set is a test suite, treat a grounding regression like a failing build.
- **Friday ritual (30 min):** checkpoint demo to yourself/Dona, review golden-set diffs, move cut-line items, re-plan next week in this file.
- **Don't touch the invariants under deadline pressure.** Cut features (each week has a cut line), never the foundation rules.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Meta WhatsApp approval slow/denied | Med | Widget is the launch bar; adapter seam ready; started day 1 |
| SMS deliverability in Israel | High | Test week 1 with real Israeli numbers; provider behind a thin adapter; signed-link fallback |
| Lease PDFs are scans / messy | High | Extraction review UI + manual field entry fallback (week 3) |
| Hebrew answer quality below bar | High | Golden set from day 1; prefer extracted structured fields over free retrieval; escalate more, invent never |
| Pilot data arrives late | Med | Weeks 2–3 run on a realistic seeded building; importer makes swap-in a one-hour job |
| OpenAI outage / cost spike | Med | Kill switches degrade to callback collection; budget caps + model ids in config |
| Solo bus-factor | Med | Runbook + this file + specs keep every decision on disk, not in your head |
| Scope creep from the vision | High | The out-of-scope list below is a wall; vision items go to the Phase 2 backlog, not into the sprint |

## Explicitly NOT in Phase 1

Voice/telephony · Russian/French/Arabic · Ziv finance integration · Salesforce mirror & Calendly sync (seams exist, integrations don't) · move-in/utility workflows · supplier portal & tenders · automated retroactive correction sweep (manual corrections + golden set suffice) · frontier report (basic reports only) · renewal drafting · payments (never — by design).

## Phase 2 backlog seeds (from the vision, in likely order)

WhatsApp GA → attention-contract dial → exception drafts everywhere + frontier report → Ziv read adapter → RU/FR/AR → renewal window + money-gate approvals lane → asset memory & preventive sweeps → retroactive sweep automation → vendor scoring into dispatch.
