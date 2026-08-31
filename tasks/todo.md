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

### Slice 12.1 — Text extraction + clause-aware chunking ☑
- [x] PDF → text; chunk on clause boundaries rather than a fixed window, so a citation can name a clause
- [x] Each chunk keeps its source location, because "cited" means traceable to a place in the document
- [x] **Two seams, in the places the architecture already had.** `kernel/pdf.ts` beside
      `objects.ts` — positioned text items, no business logic, it does not know what a lease is;
      `occupancy/internal/clauses.ts` pure like `roles.ts` and `paths.ts`, where the Hebrew that
      identifies a clause lives. One new runtime dependency, `pdfjs-dist`: positions are what
      make the two-column annex survivable and a citation traceable to a place
- [x] **`tenancy_id` is duplicated onto the chunk row** — 12.2 filters every retrieval query by
      occupancy, and a filter on a column of the table being searched is one a vector query
      cannot be written without noticing. A join back to `occupancy_documents` is a join a later
      query can be written without, and the query that forgets it returns another tenant's lease
- [x] **The annexes name their clauses in words** — and finding that out cost two of the day's
      three commits. The body writes `1.`, `3.2`; נספח א׳ writes `סעיף 5 – …`, naming the body
      clause each row qualifies. Reading only the first form left the annex the digital twin
      reads as **one chunk split by length**, cited `נספח א׳ (1/2)` — a reference naming two
      pages rather than a clause, and the foundation 13.1 would have been built on
- [x] **A property that lived for one HTTP response.** `ingestDocument` computed the pages with
      no text layer, returned them, and the redirect dropped them — while `SPEC-staff.md` claimed
      the screen showed them. `ingested_at` / `page_count` / `image_only_pages` on
      `occupancy_documents` now, written in the transaction that replaces the chunks
- [ ] ~~**Cut line (ROADMAP):** OCR for scanned PDFs~~ — **and the cut is deeper than logged.**
      Not only is OCR not built: the four image-only pages are **not detected at all**. See the
      carry list

**Done when:** the real pilot lease is chunked and every chunk points back at its clause.
**Verify:** spot-read 5 chunks against the PDF. · Size: M
**Closed 2026-08-25 — the bar, met and evidenced.** 273 chunks, read on staging by the owner in
a browser three times, once per commit (266 → 273 → 273). More than five spot-read against the
PDF; the two that carry the argument are **`נספח א׳ §5`**, holding the initial period, both
options and the ten-year cap as one citable clause, and **`נספח א׳ §10`**, holding the rent and
the maintenance fee in the clause that states them. A preamble keeps a null reference rather
than an invented one, `§20` spans a page break, and `נספח ז׳ §3.1–3.2` shows a second annex
chunking by its own numbering. Merged as [#20](https://github.com/RandomWilder/dona-v3/pull/20),
[#21](https://github.com/RandomWilder/dona-v3/pull/21) and
[#22](https://github.com/RandomWilder/dona-v3/pull/22); staging serves `99aac93`. Evidence:
`tasks/evidence/day-12-chunking.md`.

### Slice 12.2 — Embeddings → pgvector, scoped by occupancy ☑
- [x] pgvector index; **every retrieval query filtered by occupancy** — SPEC.md's isolation rule at the query layer, the same seam 7.1 built
- [x] An isolation test that *attempts the crossing*: tenant A's question must not reach tenant B's lease, asserted in both directions
- [x] Model id and dimensions are config rows, not constants (SPEC.md rule 4)
- [x] **The first model call this project has ever made.** `kernel/embeddings.ts` joins `objects.ts`
      and `pdf.ts` as a port: OpenAI over `fetch`, no SDK, `text-embedding-3-large` at 1536
      dimensions because hnsw caps at 2000 and the model is natively 3072. No key → it **throws**
      rather than returning zeros, and the boot line says so
- [x] **The repo's first config mechanism**, because rule 4 asks for the model id as a row and
      nothing config-shaped existed. One table, a typed reader, no admin screen (week 5's
      `catalog`). The dimension is schema *and* config, so the reader refuses when the row and the
      column disagree rather than failing on the two-hundredth clause
- [x] **Two infrastructure pieces**, both from doing this properly rather than quickly.
      `infra/set-secret.sh` is now the only way a credential enters this system — Secret Manager as
      the single source of truth, the value never a command-line argument, the grant per secret,
      rotation the same command. `infra/db-capabilities.sh` measured what the database permits
      *before* the migration was written, and **closed a carry item open since 7.1**: `btree_gist`
      is available and the runtime user may install it, so week 6's exclusion constraint is
      unblocked
- [x] **Three defects the real lease found after merge** — phantom clauses out of wrapped
      sentences, headings ranking as answers, and a screen misreporting its own result count.
      273 → 221 chunks ([#25](https://github.com/RandomWilder/dona-v3/pull/25))

**Done when:** a question retrieves clauses from one lease and provably cannot reach another's.
**Verify:** the isolation test, plus `npm run evals`. · Size: M→L
**Closed 2026-08-26 — the bar, met and evidenced.** Both questions return the clause that answers
them: `נספח א׳ §10` for the rent, `נספח א׳ §5` for the term. Isolation is proven by a test that
**attempts the crossing** — two near-identical leases, each asking for the other's exact text,
asserted in both directions — and a tenancy that is not yours answers with silence rather than an
error that would confirm it exists. The boot line reads
`embeddings: openai:text-embedding-3-large@1536`; ingest went 2.9s → 10.9s, which is the cost of
embedding 221 clauses and the reason auto-ingest stays deferred. Merged as
[#24](https://github.com/RandomWilder/dona-v3/pull/24) and
[#25](https://github.com/RandomWilder/dona-v3/pull/25); staging serves `f2834a9`. Evidence:
`tasks/evidence/day-12-embeddings.md`.

**Day 12 closed 2026-08-26 — both slices, five PRs.** The lease is clauses, the clauses are
findable, and they are findable **only from the tenancy that owns them**. What is not yet good is
the *order* they come back in — carried to 14.1 with a diagnosis rather than a shrug.

## Day 13 (Wed) — The digital twin

### Slice 13.1 — Extraction to structured fields ☑
- [x] End date, rent, deposit/guarantees, notice periods, deductible clauses → structured, **each traceable to its source clause** — and a list's rows cite **their own** clause, since a notice window and a who-pays rule come from different ones
- [x] **The lease's own shape, not a simplification** (`SPEC-occupancy.md`, 7.1's note): the term is an initial period plus two options capped at ten years, and rent is an **index-linked formula against a base month**, not a number. The twin must not store a single end date or a single rent figure
- [x] SPEC.md rule 7 holds absolutely: read financial context, never compute a charge
- [x] **The repo's first generative model call**, as a kernel port beside `embeddings.ts`:
      instructions, text and a strict JSON schema in, parsed JSON out. What a lease field is
      lives in `occupancy/internal/twin.ts`, pure, where the tests are
- [x] **A citation naming a clause that was not sent is rejected**, and the field is not
      stored. A wrong value with an honest citation is a correction 13.2 can make; a value
      with an invented citation is rendered as grounded by every screen after it
- [x] **Which clauses are sent is deterministic** — by clause reference and keyword, never by
      similarity, because ranking is measured-bad and carried to 14.1. It is also a privacy
      decision: selection requires a clause number, the front page has none, so the parties'
      names, ID numbers, phones and email are never sent to the provider at all
- [x] **The vocabulary is code and not a `CHECK`**, alone among this schema's closed lists:
      more fields will be defined, and a constraint would make each one a migration whose
      content is a copy of a list `twin.ts` already enforces
- [x] **The first press failed, and the fix is the more useful half.** Five sequential calls at
      the provider's default reasoning effort died at Cloud Run's 300s timeout — a blank page,
      nothing written. `reasoning_effort` was never being sent, which is not the same as
      sending `none`. Now: a per-call timeout, concurrent calls, effort as a config row, and a
      model chosen from the measurement rather than from an argument
      ([#28](https://github.com/RandomWilder/dona-v3/pull/28))

**Done when:** one real lease's fields are extracted with a clause reference on each.
**Verify:** read the extracted fields against the document. · Size: L
**Closed 2026-08-26 — the bar, met and evidenced.** Five fields, five citations, read on
staging by the owner against the PDF. The two that carry the argument: the **term** came out
as an initial period plus two options and a ten-year cap — the shape a single end date would
falsify — and the **rent** is the rent and not the maintenance fee, which is the failure
`docs/reference/lease-template-donadom.md` names for `נספח א׳ §10`, checked against page 14.
Notice windows and who-pays rules came back as lists whose rows cite four different `נספח י״א`
clauses. Latency went 504-at-300s → 189s → 8.3s across the fix. Merged as
[#27](https://github.com/RandomWilder/dona-v3/pull/27) and
[#28](https://github.com/RandomWilder/dona-v3/pull/28); staging serves `1370e89`. Evidence:
`tasks/evidence/day-13-twin.md`.

### Slice 13.2 — Admin review screen ☐
- [ ] Confirm/correct each extracted field, on top of 10.1's views and through the guarded surface
- [ ] A corrected field records who corrected it — an extraction is a claim until a human confirms it
- [ ] **Cut line (ROADMAP):** this screen may be rough

**Done when:** one real lease's fields are reviewed and confirmed on staging.
**Verify:** the confirmed record, read back. · Size: M

## Day 14 (Thu) — Retrieval that refuses

### Slice 14.1 — Guidance docs + the ranking rule ☐
> **Arrives with a measured problem and a starting hypothesis, from 12.2.** Retrieval works and
> is isolated; what it is not yet is *ordered*. Both of the owner's staging questions returned the
> right clause outside the top two, and the same two chunks won both — see below. This slice is
> where that becomes fixable, because it is the slice that builds the instrument.

- [ ] Company policy documents through the same pipeline
- [ ] Retrieval ranks **this occupancy's lease → policy → refuse**, in that order, and the refusal is a real answer rather than a fallback
- [ ] An off-lease question returns **"unknown + escalate"**, never an invention
- [ ] **The two questions from 12.2 are the first two golden cases**, with their measured answers:
      `מה גובה דמי השכירות?` → `נספח א׳ §10` (was 5th of 8) and `עד מתי חוזה השכירות?` →
      `נספח א׳ §5` (was 3rd of 8, distance `0.428`). A ranking change that does not move these is
      not a fix
- [ ] **The hypothesis to test first: long heterogeneous chunks are universal attractors.** The
      front page and an annex cover — parties, dates, addresses, parcel numbers, boilerplate — won
      *both* questions on unrelated topics. A chunk like that embeds near the centre of the space
      and sits close to everything. Every distance in both result sets fell between `0.35` and
      `0.51`, relevant and irrelevant alike, which is what "not discriminating" looks like from
      outside. Candidate answers: hybrid retrieval (keyword + vector), tighter chunk sizing for
      mixed-content pages, or down-weighting front matter — **measured, not guessed**
- [ ] **A privacy decision, not only an accuracy one.** That front page is the PII-densest chunk
      in the document — two names, two ID numbers, two phones, an email — and is currently the
      most likely text retrieved for any vague question. Week 4's agent feeds top hits into a
      prompt, so those hits reach the model. Decide it here deliberately rather than inherit it
- [ ] **`נספח א׳`'s two-column layout is half solved** (12.1). `§5` interleaves the label column
      with the value column: the dates survive and are readable, the sentence is braided. It is
      the annex the twin reads, so a second pass belongs near this work

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

## Carried in from day 13

- **A second real lease was measured, and it does not resemble the first.** 5 pages against
  38, **every one of them image-only**, yielding 0 clauses and 0 twin fields. The pipeline
  behaved correctly — `minPageChars` found no readable text, so it chunked nothing rather than
  chunking noise, and recorded `page_count 5 · image_only_pages [1,2,3,4,5]`. Two findings, not
  one: **OCR is now required** ([ADR-0002](../docs/decisions/ADR-0002-ocr-is-required.md), cut
  line withdrawn, slice placed at 15.1 with a spike first) — **and OCR is not sufficient**. A
  five-page lease is almost certainly not the tender scheme, so it has no `נספח א׳`, and
  `clauses.ts`'s numbering and `twin.ts`'s annex-first selection are tuned to a scheme it does
  not follow. That is its own slice and its own risk row.
- **The admin cannot open a tenancy.** Buildings, units, people and phones have forms; a
  tenancy and its parties do not — so a flat created in the browser has no tenancy, and a
  document has nothing to hang off. Every tenancy in this system so far arrived by importer or
  by seed, including the one this second lease needed. Fine for data that lands by CSV at
  sign-off, not fine for an office running day to day. Belongs with week 5's admin work.
- **The securities read one obligation as two.** The annex offers a cash deposit *or* a bank
  guarantee, and the twin lists both with the same stated amount — a reader adding them sees
  twice the security the lease requires. 13.2's review screen is exactly the place a human
  fixes it, and it is a golden case for 14.2. Deliberately **not** patched into the prompt:
  changing a prompt on one bad output with no eval run is PIPELINE.md §9's named anti-pattern.
- **`חיובים והשתתפות` names the payer, not the subject.** The registry asks what the charge is
  about; the model returned who bears it. Vocabulary week 5's `catalog` has to settle rather
  than inherit.
- **189s then 8.3s is unexplained.** No single call exceeded the 60s bound, so five concurrent
  calls summing to ~190s were serialized outside this system — provider-side queueing is the
  likely reading, and prompt caching the likely reason the repeat was fast. Week 4 puts a
  tenant on the other end of a model call, so it is worth settling before then: press once
  after the cache window and compare.
- **A chain of model calls sits on a browser request.** Bounded and concurrent is not the same
  as belonging there. Together with synchronous ingest, this is now two commands waiting on
  `kernel/work.ts` — which has become the most-deferred slice in the week.

## Carried in from day 12 (second pass)

- **Ranking is not good enough, and it is 14.1's** — moved into that slice above with the two
  golden cases, the measured distances and the attractor hypothesis, rather than left as a
  feeling. Nothing about it blocks day 13: the twin reads `נספח א׳ §5` and `§10` **by clause
  reference** through `listChunks`, never by similarity.
- **A running footer is still swallowed into the clause spanning it** (12.1). Detecting a repeated
  footer needs the whole document rather than one page. Noise inside a chunk, not a wrong
  citation.
- **Ingest is synchronous and now takes ~11 seconds** (12.2). A browser waits on it. Auto-ingest
  on upload wants the kernel's durable work (`work.ts`), which is its own slice.
- **`staff`'s session sweep flaked a third time** (12.2's first gate run, passing the four after).
  Still uncaptured, still wants `SPEC-staff.md` reasoning first.

## Carried in from day 12

- **The four image-only pages are not detected, and the screen says otherwise** (12.1). The
  chunks page reads *"בכל העמודים נמצא טקסט"* for a document
  `docs/reference/lease-template-donadom.md` measured as having four image-only pages. Two
  passes at the bar — "yields zero text items", then "yields under `minPageChars`" — flagged
  none, and the logs prove the second one ran (`302`, 2.9s, revision `dona-staging-00033-nls`,
  boot line `99aac93`). So **every page of the lease carries at least 40 characters**: those four
  carry a title block, a caption, a header. The note's *image-only* means the page's content is a
  picture; the code measures how much text a page yields. Different properties, and no third
  threshold bridges them, which is why a third was not chosen. Real detection asks whether a
  page's drawing operators are dominated by a full-page image — a pdfjs operator-list question
  and its own slice. **Until then the screen asserts an all-clear it cannot support**, and that
  wording is the cheaper half of the fix.
- **A running footer is swallowed into the clause that spans it** (12.1). `§20` ends with
  `- 14 -` and `נספח א׳ §10` carries `- 15 -` between the rent and the maintenance figure.
  Detecting a repeated footer needs the whole document rather than one page. Noise inside a
  chunk rather than a wrong citation, so it waits.
- **A same-day re-read is invisible.** The chunks page shows the read *date* and not the time, so
  re-reading a document changes nothing on screen — which cost a full round of "did it even run"
  that only the Cloud Run logs could answer. The screen should carry the evidence of its own last
  action.
- **A chunk's boundaries are a heuristic, not a parse** (12.1). Two clause forms are read;
  a lease laid out unlike the tender's scheme will chunk worse, and the honest place to find that
  out is a second real lease.

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
