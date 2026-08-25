# Week 3 — Lease ingestion & grounded answers

> One slice = one focused Claude Code session (half a day or less). Every day ends with staging deployed. Format: each slice has **Done when** (the acceptance bar) and **Verify** (the command or check that proves it — no self-certification).

**Week goal:** a real lease answers questions with clause citations — before any tenant UI exists.
**Week demo (Friday):** curl the internal answer endpoint with a real lease question → Hebrew answer + the clause it came from.

Previous week: `tasks/week-2.md` (closed — the pilot building is browsable, role-gated and audited, `v0.2.0` on prod).

> **This is the week the product starts being the product.** Weeks 1–2 built an operations system of record; nothing in it has been an LLM yet. From here the golden set (`evals/`) stops being three placeholder cases and becomes the thing that gates every merge — PIPELINE.md §6. Any slice touching a prompt, a model id, retrieval, or a tool definition runs the full set.

---

## Day 11 (Mon) — Make the ground match the plan

> **Nothing here waits on anyone.** Fuse 3 stopped being a blocker on 2026-08-25: development
> runs on mock data we define (PIPELINE.md §1.5), and the data request to Dona Dom is derived
> from our templates at sign-off. Slice 8.1 closed under that corrected bar.

### Slice 11.1 — Reset staging and seed it from the template ☑
- [x] ~~**Staging carries ~1,291 test buildings and ~1,000 test people**~~ — **it did not, and
      measuring that was the slice.** Staging held **one person and no buildings**; the
      preserved counts alongside (2 operators, 27 audit rows) prove it was the right database.
      The residue is on the **laptop** (2,843 people, 2,721 buildings) and in CI's throwaway
      service container — `ci.yml:41` runs against `127.0.0.1:5432`, which dies with the job,
      and nothing outside the app had ever reached staging's database. The hazard was real —
      the importer keys a person by phone, so a dirty database returns the *wrong people*,
      three of five lookups when it was measured during 8.1 — but those were local lookups.
      The fix stands; the reason written into the code and the runbook is now the true one
- [x] Truncate the **domain** tables only — `identity` / `portfolio` / `occupancy`. Leave
      `staff_operators`, `staff_sessions` and `audit_log` intact: the logins are in use and the
      week-2 audit trail is evidence. Counted before and after, and a preserved table that
      moves raises. No `CASCADE`, so an unlisted table that references one of these fails
      loudly instead of being reached through
- [x] **`idempotency_keys` had to go with them** — not on the original list, and the finding of
      the slice. Every key memoizes a domain command (`identity.addPerson:import:person:…`),
      so emptying people while keeping the memo hands the next import the id of a person who
      no longer exists: a broken graph that looks like a clean re-seed. Staff auth never
      touches the store
- [x] Re-seed from `docs/reference/tenant-table-template.csv`, so staging *is* the mock
      building we designed — 3 buildings, 10 units, 13 people, one vacancy, one guarantor
- [x] **Repeatable, not a one-off.** `infra/reset-staging-data.sh` — staging only, with no flag
      that changes it: it reads the connection name out of the secret and refuses anything but
      `dona-staging` before opening a tunnel
- [x] **A local→Cloud SQL path** established and written into `docs/runbook-deploy.md`,
      including the two things that waste an hour on a fresh machine: the sudo prompt from the
      SDK's own Python installer, and ADC being a separate credential from `gcloud auth list`

**Done when:** `נכסים` on staging shows exactly the template's three buildings, and a phone
lookup returns the person the CSV says it should.
**Verify:** browse staging; five `resolveByPhone` spot-checks against the CSV. · Size: M
**Closed 2026-08-25 — both halves.** Staging reads `buildings 3 · units 10 · people 13 ·
tenancies 10`, and **seven** spot-checks resolve to the person the CSV names, including one
person reaching two tenancies with different access from a spelling not in the file. The
browse was run by the owner, as the week-2 demo was: `נכסים` shows exactly גני אלון (הנשיא 8,
חיפה) · בית שקד (ביאליק 12א, רמת גן) · מעונות הדר (ארלוזורוב 45, תל אביב), and בית שקד opens on
its three flats 2 / 5 / 8 at floors 1 / 2 / 4 — the CSV, to the row. Merged as
[#16](https://github.com/RandomWilder/dona-v3/pull/16); staging serves `1f01462`. Evidence:
`tasks/evidence/day-11-staging-reset.md`.

### Slice 11.2 — Lease upload → GCS, attached to an occupancy ☑
> **Working document:** the real signed lease already in the buckets. Asaf's call on
> 2026-08-25, taken against the recommendation to mock it and recorded with its cost on fuse 3:
> a lease we write ourselves would be clean in exactly the ways extraction needs to be tested
> against. **Its removal from both buckets is owed at phase-1 sign-off** — it is the one piece
> of real data in the system, and it holds ID numbers and signatures in an environment with no
> alerting, no PITR and no deletion path.

- [x] Admin upload on the unit view; object lands in `gs://dona-v3-<env>-docs` under a path that carries the **place and never the people** (7.0's rule — paths reach logs)
- [x] **The path convention changed, from a readable address to ids**, and the reason is worth
      keeping: generating 7.0's hand-made shape means transliterating Hebrew *in code*, and two
      streets that transliterate alike file one flat's lease under another's — a correctness
      failure with isolation flavour, arriving quietly. Ids also do not rot when an address is
      corrected. The database row is the index now; 7.0's one object is grandfathered
- [x] The document row is attached to an **occupancy**, not a unit or a person: that is the scope
      every later read is filtered by. The tenancy is resolved **server-side** from the unit and
      is never a hidden field — a caller-supplied id would let a crafted post file a document
      against a tenancy the operator never opened
- [x] `objectCreator` granted in `bootstrap.sh` — and deliberately **not** `objectAdmin`: the app
      can write a contract and read one, and cannot destroy one, which matters while there is no
      retention rule and no deletion path
- [x] **The finding:** `idempotency_keys`' sibling problem, one slice on — a document has no
      natural key, so this is the module's first command that is *not* idempotent, and it says so
      rather than pretending. A re-upload is a second document, because a re-upload is usually a
      correction and discarding it would lose the correction

**Done when:** a real lease uploads from the admin and comes back down attached to the right tenancy.
**Verify:** upload on staging, then read the object back and confirm the path names no person. · Size: M
**Closed 2026-08-25 — both halves.** The real signed lease, 1,695,258 bytes, uploaded by the owner
in a browser on staging and read back byte-for-byte, at a path that is four ids and the word
`lease`. Its **own address** was seeded as a fourth building with **zero parties**, so the one real
contract in the system hangs off a tenancy matching its contents and no real person entered the
database. `app-staging`'s new write grant is proven by the object existing. Merged as
[#18](https://github.com/RandomWilder/dona-v3/pull/18); staging serves `bfec0bb`, boot line
`docs: gs://dona-v3-staging-docs`. Evidence: `tasks/evidence/day-11-lease-upload.md`.

**Day 11 closed 2026-08-25 — both slices.** Staging is the mock building we designed, and the one
real lease is in it, attached to its own tenancy and to nobody.

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
- ~~**The real tenant table**~~ — no longer carried. Fuse 3 was reframed 2026-08-25: dev runs on data we define, the request is derived from our templates at sign-off, and 8.1 closed under the corrected bar.
- ~~**Staging carries test residue** (~1,291 buildings, ~1,000 people)~~ — **withdrawn 2026-08-25, measured false.** Staging held one person and no buildings; the residue is local and CI-ephemeral. Closed by 11.1, which now seeds rather than cleans. **The building list is unbounded** remains true and is now un-evidenced by anything on staging — a few-dozen-building portfolio does not need pagination, and staging holds three. Carried to week 6 hardening rather than week 3.
- **The real lease leaves both buckets at phase-1 sign-off** — and now `occupancy_documents` **and `occupancy_document_chunks`**, which since 12.1 holds the contract's clause text verbatim: deleting the objects alone would leave the lease readable in Postgres. Three things, not one, for a deletion path to know about. Fuse 3 holds the deadline.
- **A document cannot be removed, corrected or replaced** (11.2). Uploading again adds a second document rather than a version — honest for a correction, and not a substitute for an edit path.
- **A reset orphans document objects on purpose** (11.2). `occupancy_documents` is truncated with the domain tables — and `occupancy_document_chunks` with it since 12.1, so a reset does not leave a lease's clauses pointing at a document that is gone. The objects stay in the versioned bucket, because deleting is the one operation this system has no path for until week 6.
- **`administer` has no command and there is no operator-management screen.** The week-2 viewer arrived by a seeder; a third operator or a role change is still a manual database task.
- **`staff`'s session sweep makes the suite flaky.** `login()` and `readSession()` each delete every expired session using their own clock, and `node --test` runs files in parallel against one database. Seen once in five gate runs during 7.1, and once more in 10.1 — uncaptured, and not reproduced in 17 runs after. Wants `SPEC-staff.md` reasoning first.
- **Overlapping tenancies on one unit are not prevented in general.** `UNIQUE (unit_id, starts_on)` stops the re-run-import case; two tenancies with different start dates and overlapping ranges are still insertable. The fix is an exclusion constraint over a `daterange`, needing `btree_gist` — whether the Cloud SQL runtime user may `CREATE EXTENSION` is unverified.
- **Week 6 hardening, all named:** `npm audit` not in the CI gate · per-service IAM scoping · the default compute SA's project-level `editor` · document retention and a deletion path · CMEK and data-access audit logs · prod alerting, PITR, private IP · CSP headers, per-IP rate limits, password rotation, login CSRF.
- **Domain for `app.` / `admin.`** — owed by Dona Dom, not blocking.
