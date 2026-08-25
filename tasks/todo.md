# Week 3 — Lease ingestion & grounded answers

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployed. Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** a real lease answers questions with clause citations — before any tenant UI exists.
**Week demo (Friday):** curl the internal answer endpoint with a real lease question → Hebrew answer + the clause it came from.

Previous week: `tasks/week-2.md` (closed — the pilot building is browsable, role-gated and audited, `v0.2.0` on prod).

> **This is the week the product starts being the product.** Weeks 1–2 built an operations system of record; nothing in it has been an LLM yet. From here the golden set (`evals/`) stops being three placeholder cases and becomes the thing that gates every merge — PIPELINE.md §6. Any slice touching a prompt, a model id, retrieval, or a tool definition runs the full set.

---

## Day 11 (Mon) — The blocked bar, and the ground it lands on

### Slice 11.1 — Close 8.1 with the real table ☐
> **Carried from week 2. Blocked on Dona Dom** (`tasks/fuses.md` fuse 3, requested 2026-08-22, outstanding). Everything else in this slice is ready: the importer is built and tested, and `docs/reference/tenant-table-template.csv` is the format written as an example so the file arrives in a shape that loads.

- [ ] `npm run import -- <file>` (dry) → read every reject → `--commit` against staging
- [ ] **5 spot-checks against the source document** — the bar that cannot be faked and the only reason this is still open
- [ ] **Decide staging's residue first, not after.** Staging holds ~1,291 test buildings and ~1,000 test people. Validating the specimen locally returned the *wrong people* for three of five lookups, because the importer keys a person by phone and those numbers were already taken. A real import onto dirty ground repeats that with real tenants — so this slice starts by deciding: clean staging, or import into a fresh database

**Done when:** the real pilot slice imports; re-running is a no-op; 5 spot-checks pass.
**Verify:** the five lookups, read against the document by a human. · Size: M

### Slice 11.2 — Lease upload → GCS, attached to an occupancy ☐
- [ ] Admin upload on the unit view; object lands in `gs://dona-v3-<env>-docs` under a path that carries the **place and never the people** (7.0's rule — paths reach logs)
- [ ] The document row is attached to an **occupancy**, not a unit or a person: that is the scope every later read is filtered by
- [ ] `objectCreator` granted in `bootstrap.sh` — 7.0 deliberately granted read only, "until the slice that needs it". This is that slice

**Done when:** a real lease uploads from the admin and comes back down attached to the right tenancy.
**Verify:** upload on staging, then read the object back and confirm the path names no person. · Size: M

## Day 12 (Tue) — Ingestion

### Slice 12.1 — Text extraction + clause-aware chunking ☐
- [ ] PDF → text; chunk on clause boundaries rather than a fixed window, so a citation can name a clause
- [ ] Each chunk keeps its source location, because "cited" means traceable to a place in the document
- [ ] **Cut line (ROADMAP):** OCR for scanned PDFs — log as a manual-entry fallback rather than build it

**Done when:** the real pilot lease is chunked and every chunk points back at its clause.
**Verify:** spot-read 5 chunks against the PDF. · Size: M

### Slice 12.2 — Embeddings → pgvector, scoped by occupancy ☐
- [ ] pgvector index; **every retrieval query filtered by occupancy** — SPEC.md's isolation rule at the query layer, the same seam 7.1 built
- [ ] An isolation test that *attempts the crossing*: tenant A's question must not reach tenant B's lease, asserted in both directions
- [ ] Model id and dimensions are config rows, not constants (SPEC.md rule 4)

**Done when:** a question retrieves clauses from one lease and provably cannot reach another's.
**Verify:** the isolation test, plus `npm run evals`. · Size: M→L

## Day 13 (Wed) — The digital twin

### Slice 13.1 — Extraction to structured fields ☐
- [ ] End date, rent, deposit/guarantees, notice periods, deductible clauses → structured, **each traceable to its source clause**
- [ ] **The lease's own shape, not a simplification** (`SPEC-occupancy.md`, 7.1's note): the term is an initial period plus two options capped at ten years, and rent is an **index-linked formula against a base month**, not a number. The twin must not store a single end date or a single rent figure
- [ ] SPEC.md rule 7 holds absolutely: read financial context, never compute a charge

**Done when:** one real lease's fields are extracted with a clause reference on each.
**Verify:** read the extracted fields against the document. · Size: L

### Slice 13.2 — Admin review screen ☐
- [ ] Confirm/correct each extracted field, on top of 10.1's views and through the guarded surface
- [ ] A corrected field records who corrected it — an extraction is a claim until a human confirms it
- [ ] **Cut line (ROADMAP):** this screen may be rough

**Done when:** one real lease's fields are reviewed and confirmed on staging.
**Verify:** the confirmed record, read back. · Size: M

## Day 14 (Thu) — Retrieval that refuses

### Slice 14.1 — Guidance docs + the ranking rule ☐
- [ ] Company policy documents through the same pipeline
- [ ] Retrieval ranks **this occupancy's lease → policy → refuse**, in that order, and the refusal is a real answer rather than a fallback
- [ ] An off-lease question returns **"unknown + escalate"**, never an invention

**Done when:** a question with no grounding refuses instead of inventing.
**Verify:** the golden set's refusal cases. · Size: M

### Slice 14.2 — Golden set v1 in CI ☐
- [ ] ~30 real-style Hebrew cases: grounding · refusal-to-invent · **isolation** (asking about another tenant's lease must fail) · escalation triggers · tone
- [ ] Assertions on **which tool was called and whether a citation is present**, not on final text (PIPELINE.md §6)
- [ ] It gates merges — the same standing as a failing unit test

**Done when:** the set runs in CI and blocks a merge on a grounding or isolation regression.
**Verify:** open a PR that breaks grounding on purpose and watch it fail. · Size: L

## Day 15 (Fri) — Checkpoint

### Slice 15.1 — Week 3 checkpoint ☐
- [ ] Run the week demo; tick ROADMAP week 3; write week 4's todo
- [ ] Tag `v0.3.0` → prod

**Done when:** a real lease question returns a Hebrew answer with a clause citation; ROADMAP week 3 ticked.
**Verify:** `v0.3.0` live on prod. · Size: S

---

## Carry rules
- A slice that doesn't finish moves to tomorrow **as-is** — never half-merge.
- Anything cut under pressure gets written at the bottom here, not silently dropped.
- External fuses (`tasks/fuses.md`) get a one-line status check every morning.

## Carried in from weeks 1–2
- **The real tenant table** — fuse 3, and slice 11.1's whole content.
- **Staging carries test residue** (~1,291 buildings, ~1,000 people) and **the building list is unbounded**. 11.1 decides both.
- **`administer` has no command and there is no operator-management screen.** The week-2 viewer arrived by a seeder; a third operator or a role change is still a manual database task.
- **`staff`'s session sweep makes the suite flaky.** `login()` and `readSession()` each delete every expired session using their own clock, and `node --test` runs files in parallel against one database. Seen once in five gate runs during 7.1, and once more in 10.1 — uncaptured, and not reproduced in 17 runs after. Wants `SPEC-staff.md` reasoning first.
- **Overlapping tenancies on one unit are not prevented in general.** `UNIQUE (unit_id, starts_on)` stops the re-run-import case; two tenancies with different start dates and overlapping ranges are still insertable. The fix is an exclusion constraint over a `daterange`, needing `btree_gist` — whether the Cloud SQL runtime user may `CREATE EXTENSION` is unverified.
- **Week 6 hardening, all named:** `npm audit` not in the CI gate · per-service IAM scoping · the default compute SA's project-level `editor` · document retention and a deletion path · CMEK and data-access audit logs · prod alerting, PITR, private IP · CSP headers, per-IP rate limits, password rotation, login CSRF.
- **Domain for `app.` / `admin.`** — owed by Dona Dom, not blocking.
