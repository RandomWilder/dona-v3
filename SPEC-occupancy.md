# SPEC: occupancy

Conventions inherited from SPEC.md. The join module: it is the only place in the system
where a person and a place meet.

- **Responsibility:** Current tenancy — who lives where, who is billed, who guaranteed it;
  lease documents indexed per occupancy, and the clauses they are cut into (week 3)
- **Depends on:** identity, portfolio — through their `contract.ts` only
- **Commands:** `openTenancy` · `addParty` · `endTenancy` · `getTenancy` · `resolveByPhone`
- **Events:** none yet — nothing downstream reacts to a tenancy opening

## Why this module is load-bearing (slice 7.1)

Week 2's sentence is `phone → person → unit → current occupancy`. `identity` is its first
two words and `portfolio` its third; this module is the last one, and the arrows between
them. Nothing else in the system knows that a person and a unit are related.

That makes it the seam SPEC.md's **"absolute tenant isolation enforced at the query layer"**
hangs on. Every read in weeks 3–5 — the lease a tenant may ask about, the case they may
open, the history they may see — is scoped by what `resolveByPhone` returns. A wrong answer
here is not a bug in one screen; it is one tenant reading another's tenancy, which is the
failure SPEC.md forbids, arriving through the front door rather than through an attack.

So this module got its isolation tests before it got features.

## Tables

Migration `0006_occupancy.sql`. The kernel runs it and never reads it (SPEC-kernel.md,
"module-owned tables"). `created_at` carries no `DEFAULT now()` anywhere, as in `0004` and
`0005`: time in SQL comes from the injected clock.

| Table | Holds |
|---|---|
| `occupancy_tenancies` | `id`, `unit_id`, `starts_on`, `ends_on`, `parking_spot`, `storage_unit`, `created_at` |
| `occupancy_parties` | `(tenancy_id, person_id, role)` — a person may hold more than one role |

### The foreign keys cross module lines, deliberately

`occupancy_tenancies.unit_id` references `portfolio_units`, and
`occupancy_parties.person_id` references `identity_people`. AGENTS.md's boundary rule
governs *code* imports — no module reaches past another's `contract.ts`, and this one does
not. SPEC.md's module map already declares `occupancy` depends on both, so the direction is
legal and there is no cycle.

Referential integrity is then Postgres's job, by the same argument that made
`identity_phones.phone` a primary key rather than an indexed column: this is the one place
the join exists, and a dangling tenancy is exactly the kind of thing that must be impossible
rather than merely unlikely. `ON DELETE RESTRICT` throughout — a unit with a tenancy on it
cannot quietly vanish.

### The role is on the link, not on the person

The real Dona Dom lease (`docs/reference/lease-template-donadom.md`) has **three kinds of
party, not two**: two tenants jointly and severally, and a guarantor who signs the שטר חוב,
has his own phone number, and does not live there.

`role` is one of `tenant` · `billed` · `guarantor`, enforced by a CHECK constraint, and it
lives on the tenancy↔person link. Putting it on the person would make the guarantor a
`tenant` *system-wide* — and would leave nowhere to say that one man guarantees his
daughter's flat while renting his own. On the link, both facts fit, and `identity` needs no
change at all: it still only knows people, phones and person-kinds.

A person holds **one row per role**. Someone who lives there and also pays holds `tenant`
and `billed` — the same shape as `identity_person_kinds`, and for the same reason.

`billed` is not a synonym for `tenant`. A parent paying a student's rent is `billed` and
nothing else; they are a party to the tenancy who does not live in the flat, exactly as the
guarantor is.

### Parking and storage belong to the tenancy

Both are numbered in the lease, and the lease lets the landlord **reassign a bay**,
temporarily or permanently — EV-charger installation is named as a reason. A reassignment is
therefore a change to the *tenancy*, not to the building, which is why `parking_spot` and
`storage_unit` are nullable columns here and not on `portfolio_units`. Putting them on the
unit would make one tenant's reassignment rewrite the place itself.

## What "current" means

```
starts_on <= today AND (ends_on IS NULL OR ends_on >= today)
```

Inclusive at both ends: the day a tenancy starts, it is current; the day it ends, it is
still current.

**`today` is the injected clock rendered in `Asia/Jerusalem`**, not in UTC —
`($1::timestamptz AT TIME ZONE 'Asia/Jerusalem')::date`. Israel runs two or three hours
*ahead* of UTC, so the Israeli date advances first: at 00:30 in Tel Aviv it is still
yesterday in UTC. Comparing in UTC therefore lands every boundary up to three hours late,
in both directions:

- a tenancy beginning 1 October is not current for a tenant messaging at 00:30 on
  1 October — they are told they have no tenancy, on the morning they moved in;
- a tenancy that ended 30 September is still reported current at 01:00 on 1 October, which
  is the same mistake pointing at someone who has left.

The tenants are in Israel and the dates in the lease are Israeli dates. Two tests pin the
boundary with a `fixedClock` at `21:30Z` — 00:30 the next day in Tel Aviv — one on each
side, because each catches a UTC comparison failing in the opposite direction.

`ends_on IS NULL` is an open-ended tenancy. A non-null `ends_on` is **the end of the term
currently in force, not the lease's ultimate expiry** — the lease runs an initial period
plus two options capped at ten years overall, so exercising an option is an update to this
column rather than a contradiction of it. Week 3's digital twin models the term structure;
`resolveByPhone` only ever needs to know "is this current", which is why one date range is
enough here and would not be enough there.

## Idempotency: no intent keys

This module sides with `portfolio`, not `identity`. A tenancy has a **natural key** —
`UNIQUE (unit_id, starts_on)`, one tenancy of one unit beginning on one date — so
`openTenancy` is idempotent on the unique index and the kernel's `once()` is unused here.
`addParty` is idempotent on its primary key, as `identity`'s kinds are.

This is the property the day-8 importer rests on: re-running the same file cannot produce a
second tenancy, because the second insert collides with the first rather than relying on the
importer to remember.

`endTenancy` is the exception in shape, not in principle: setting the same end date twice is
the same tenancy, and setting a *different* one is a `conflict` rather than a silent
overwrite. A tenancy that ended on the wrong date is a correction, and a correction should
have to say so.

## Commands

All five go through `contract.ts`; nothing outside the module touches `internal/`.
`identity` and `portfolio` arrive as injected dependencies typed by their own contracts, so
the dependency is visible in the constructor rather than buried in a join.

### `openTenancy({ unitId, startsOn, endsOn?, parkingSpot?, storageUnit? }, actor) → Tenancy`

The unit's existence is checked through `portfolio.getUnit(unitId)`, which turns an unknown
unit into a `not_found` sentence rather than a foreign-key driver error. Dates are `YYYY-MM-DD`
strings, validated at the edge; `endsOn` before `startsOn` → `invalid`.

### `addParty({ tenancyId, personId, role }, actor) → Party`

Unknown tenancy or person → `not_found`; unknown role → `invalid`.

### `endTenancy({ tenancyId, endsOn }, actor) → Tenancy`

Unknown tenancy → `not_found`; `endsOn` before the tenancy's `startsOn` → `invalid`; a
different end date already recorded → `conflict`.

### `getTenancy(tenancyId) → TenancyView`

The tenancy, its parties with their roles, and the unit. An unknown id is `not_found`, not
`null` — an id must have been issued by something, so a miss is a dangling reference. This
follows `portfolio.getUnit` rather than `identity.findByPhone`.

### `findCurrentTenancy(unitId) → TenancyView | null`

The join read from the other side. `resolveByPhone` enters at a person and arrives at a
place; the admin unit view enters at a place and needs to arrive at people, and until 10.1
nothing could go that direction.

**It reuses the same `today` predicate as `resolveByPhone`** — the module-level constant in
`internal/tenancies.ts`, not a second copy of the SQL. "What current means" above is a rule
this module has exactly one statement of; two statements is how the guarantor boundary comes
back three hours late on one path and not the other. The boundary tests pin `21:30Z` from
both sides here as they do there, and both flip if the `AT TIME ZONE` is dropped.

**`null`, not `not_found`, for a unit standing empty.** The unit id is a system id, so the
system-id rule would say `not_found` — but the miss here is not a dangling reference. The
unit exists and the question "who lives here" has the true answer "nobody right now": an
empty flat between tenancies is an ordinary state of the world, and the admin view renders it
as a vacancy rather than as an error. A unit id that names nothing at all is a different
matter, and `portfolio.getUnit` raises `not_found` for it before this is reached.

**At most one.** The unique key is `(unit_id, starts_on)`, which does not by itself stop two
overlapping tenancies on one unit — see "Not yet in place". Until that constraint exists this
read orders by `starts_on DESC` and returns the most recent current one, and its test asserts
that shape deliberately rather than by accident. Note what is *not* being done: 7.1 rejected
"most recent wins" for `resolveByPhone`, because there a person renting two flats is a fact
and collapsing it answers about the wrong flat. Here the plurality would be data corruption
rather than a fact, and the view showing the latest is the least-wrong reading of a state
that should not exist.

### `resolveByPhone(phone) → OccupancyResolution | null`

The chain the agent calls on every conversation.

```
{
  person: Person,                  // from identity.findByPhone
  tenancies: [{
    tenancy: Tenancy,              // incl. parkingSpot / storageUnit
    roles: OccupancyRole[],        // this person's roles on this tenancy, sorted
    access: 'resident' | 'party',
    unit: UnitView,                // from portfolio.getUnit
  }]                               // current only, ordered by startsOn
}
```

- **`null` means nobody holds this number.** An answer, not a failure — the
  `identity.findByPhone` rule. The caller decides what an unknown number means; for the
  channel adapter in week 4 it means "offer a callback, disclose nothing".
- **`tenancies: []` means the person is known and lives nowhere.** A vendor, an owner, an
  ex-tenant. Distinct from `null`, and neither is an error.
- **A list, never a guess.** A person renting two flats is a fact, not a conflict, and
  picking "the most recent" would be the one shape that can silently answer about the wrong
  flat. Callers that require exactly one assert on the length and say so.
- **Access notes are never requested.** `getUnit` is called without `includeAccessNotes`, so
  an entry code cannot reach a resolution by accident. A caller who needs one asks
  `portfolio` for it, having first decided it is entitled to.

## Roles and access (`internal/roles.ts`)

Its own unit, pure: no clock, no pool, no database — as `identity`'s `phone.ts` and
`portfolio`'s `keys.ts` are.

`tenancyAccess(roles)` returns `resident` if the roles include `tenant`, and `party`
otherwise. That single value is what makes "a guarantor does not get a tenant's access" a
**seam rather than a convention**: it is computed once, from the link, and week 3's document
retrieval is scoped by it instead of re-deciding the question.

A guarantor is a `party`. So is a `billed` party who is not also a tenant. Being on the hook
for the money is not the same as living behind the door, and only the second earns the
entry code, the fault history, and the lease's contents.

Building this seam in 7.1 — with every party the lease will ever carry — is deliberate. The
alternative is reopening it in week 3, against real tenant data, with retrieval already
written on top of it.

## Lease documents (slice 11.2)

The module map in `SPEC.md` assigns lease documents here — *"lease documents (indexed per
occupancy)"* — and this is the slice that builds them. A document hangs off a **tenancy**,
never off a unit and never off a person. That is not filing convenience: it is the scope
every later read is filtered by. Week 3's retrieval is scoped by `tenancyAccess`, and a
document attached to a unit would outlive the tenancy that may see it.

| Table | Holds |
|---|---|
| `occupancy_documents` | `id`, `tenancy_id`, `kind`, `object_path`, `content_type`, `byte_size`, `created_at` |

Migration `0009_occupancy_documents.sql`. `ON DELETE RESTRICT` to the tenancy, as
everything else in this module is; `object_path` is `UNIQUE`, so two rows can never claim
one object.

### The path names the place with ids, and nothing else

```
leases/bldg-<buildingId>/unit-<unitId>/tenancy-<tenancyId>/<kind>-<documentId>.pdf
```

Slice 7.0's rule is that a path carries the place and never the people, because paths reach
logs, error messages and audit rows. It wrote that rule as a readable address —
`leases/bet-shemesh/harav-kook-48/bldg-204/unit-24/…`, transliterated by hand for the one
document uploaded by hand.

Generating that shape means transliterating Hebrew **in code**, and two streets that
transliterate alike would file one flat's lease under another's. That is a correctness
failure with isolation flavour, arriving quietly. Ids also do not rot: correcting a
building's address leaves every object still correctly filed, where a text path would be
stale and objects cannot be cheaply renamed.

So the path is ids, and the **row is the index** from an address to an object. Finding a
lease by address is a query, which is what a database is for. The single hand-uploaded
object keeps its old path; it is grandfathered, not migrated.

### What is deliberately not stored

- **The client's filename.** `lease-cohen-signed.pdf` is a person's name in a string that
  reaches logs. It is discarded on arrival, not stored and not echoed. `kind`, content type
  and size say what an operator needs.
- **Who uploaded it.** That is in `audit_log`, written by the staff edge that called this.
  One store and not two — the argument `staff`'s guarded surface already makes when it
  records the capability rather than the payload.

### Object first, row second

`attachDocument` writes the object before it writes the row, and the order is deliberate.

A put that succeeds with a failed insert leaves an orphan object in a versioned bucket:
invisible, recoverable, costing storage. The reverse leaves a **row whose document is not
there** — a lease the admin lists and cannot open, which is a lie the screen renders on the
system's behalf. Between an unreferenced object and a dangling reference, this module
already has a stated preference: `ON DELETE RESTRICT` everywhere, because a dangling
tenancy must be impossible rather than unlikely.

A contract test asserts it by failing the store and finding no row.

### Limits are code, not config rows

`application/pdf` only, and 20 MB. A stated exception to `SPEC.md` rule 4, on the same
argument `staff`'s role matrix makes: rule 4 governs tunables, and a size cap that a
database write could raise is a memory-exhaustion lever rather than a policy. Changing
either costs a deploy and leaves a diff.

`application/pdf` alone because slice 12.1 extracts text from a PDF and nothing else. A
scan arrives as a PDF too, and a scan is what the second real lease turned out to be — five
pages, all five image-only, zero clauses. OCR was week 3's cut line with manual entry as the
fallback; **that was withdrawn 2026-08-31** and OCR is required
(`docs/decisions/ADR-0002-ocr-is-required.md`). Until the slice lands, a scanned lease is
accepted, stored, and honestly reported as unreadable.

### Commands

#### `attachDocument({ tenancyId, kind, contentType, bytes }, actor) → Document`

Unknown tenancy → `not_found`. A content type other than `application/pdf`, an empty body,
or a body over the cap → `invalid`. The unit and building the path needs are read through
`portfolio.getUnit`, so a document cannot be filed under a place this module invented.

**Not idempotent, and it says so.** This module's other commands rest on natural keys; a
document has none — the same file uploaded twice is a second document, because the second
upload is usually a correction and discarding it would lose the correction. The browser
form has no intent to key on either.

#### `listDocuments(tenancyId) → Document[]`

Newest first. Metadata only: no bytes, no store round trip.

#### `readDocument(documentId) → { document, bytes }`

Unknown id → `not_found`; a row whose object has gone → `unavailable`, never an empty file.

Both reads are unaudited here, as this module's other reads are, and their callers audit
their own use — `staff` writes a row when an operator opens a document, exactly as it does
for a unit.

## Lease chunks (slice 12.1)

A stored document is bytes. This slice makes it *readable by clause*: PDF text out, chunks
in, each one carrying the place in the document it came from. Slice 12.2 embeds these rows;
13.1 extracts the twin's fields from them. Nothing here is a model call — the whole slice is
deterministic, which is why it can be pinned by unit tests before retrieval sits on top.

`docs/reference/lease-template-donadom.md` measured the ground first, and two of its findings
are the design:

- **34 of 38 pages carry a clean Hebrew text layer.** Hebrew OCR is not needed for the prose,
  which was the largest unknown in the week-3 plan.
- **The difficulty is layout, not characters.** נספח א׳ — where the unit, the term, the rent
  and the securities live — is a two-column label/value table, and naive extraction interleaves
  each value with the label on the line *above* it. A lease read that way answers "מהו גובה
  דמי השכירות" with the maintenance fee. Clause-aware chunking is required for a correct
  answer, not for a tidier one.

| Table | Holds |
|---|---|
| `occupancy_document_chunks` | `id`, `document_id`, `tenancy_id`, `ordinal`, `clause_ref`, `heading`, `page_from`, `page_to`, `text`, `created_at` |

Migration `0010_occupancy_document_chunks.sql`. `ON DELETE RESTRICT` to both parents, as
everything else in this module is.

### `tenancy_id` is on the chunk row, deliberately duplicated

It is reachable through `document_id`, and it is stored anyway. Slice 12.2's rule — SPEC.md's
"absolute tenant isolation enforced at the query layer" — is that **every retrieval query is
filtered by occupancy**. A filter on a column of the table being searched is one `WHERE`
clause that a vector search cannot be written without noticing; a filter that requires joining
back to `occupancy_documents` is a join a later query can be written without, and the query
that forgets it returns another tenant's lease.

The duplication is safe because a document never moves between tenancies: `attachDocument`
resolves the tenancy server-side and nothing can re-file a document afterwards. The value is
copied from the document row at ingest and is never taken from a caller.

### Two ways a clause announces itself

The body numbers its clauses `1.`, `3.2`, `12.1.4` at the start of a line. **The annexes do
not.** נספח א׳ writes `סעיף 5 – תקופת השכירות`, naming the body clause its row qualifies,
because the annex is a table of commercial terms keyed by the agreement it amends.

Both forms are clause starts and both are detected. Measured on the real lease: reading only
the first form left נספח א׳ — *the annex the digital twin reads*, holding the term structure,
the rent, the maintenance fee and the securities — as a **single chunk split by length**,
cited as `נספח א׳ (1/2)`. That is a reference naming two pages rather than a clause, which is
exactly what 13.1 cannot be built on. The reference note's rule is that anything reading a
lease "must go to נספח א׳ first"; a chunker that cannot see the annex's own numbering cannot.

`סעיף` also appears mid-sentence — "כאמור בסעיף 12" — so the form is anchored to the start of
a line and requires a number after the word.

**The two forms are guarded differently.** A bare leading number is ambiguous, because a
sentence that wraps can begin with one; the keyword form is not, because the word leads and a
number is required after it. So only the bare number has to earn its reading.

Measured on the real lease, reading every leading number as a clause invented two: `§18` out of
*"…ועל כן יחולו הוראות סעיף / 18 להלן."*, and `נספח י״ב §43` out of the parcel numbers
*"גוש 80031 חלקה / 43 ו-46 המצויים…"*. Both are one sentence wrapping onto a line that happens
to start with a digit, and both then competed for rank against real clauses as three-word
fragments — one of them citing a land-registry entry as a contractual term.

The test is narrow because each signal alone is wrong. **A separator after the number cannot be
required**: `נספח י״א §2.2.4` is a real clause without one. **A previous line ending
mid-sentence is not damning either**: clause text wraps constantly. Only the pair is
conclusive — a bare number, no separator, and a line above still in the middle of a sentence.

**A third phantom, found in 14.1b: the annex marker had the same disease.** `נספח` followed by one
or two Hebrew letters read `נספח זה מפרט את התנאים…` — *"this annex sets out the terms"*, the way an
annex's own preamble opens — as an annex lettered ז. Everything after it was then numbered
`נספח זה §…`: a citation naming an annex that does not exist. The marker now has to *look* like a
marker — a letter carrying a geresh or gershayim (`א׳`, `י״ב`), or a single letter standing alone —
and not merely start like one. Same fix as the bare number's, one level up.

### The two-column annex, second pass (slice 14.1b)

12.1 bound a value to the label on its own baseline, which stopped a lease answering "what is the
rent" with the maintenance fee. It left the other half standing, and the day-12 evidence named it:
when a **label cell wraps and its value cell wraps too**, the two columns' lines fall at slightly
different heights and reading by baseline interleaves them.

```
תקופת השכירות הראשונה ומועדי: החל מיום 1 במרץ 2026
תחילתה וסיומה: ועד יום 28 בפברואר 2029
```

The dates survive — which is why 13.1 could read this clause at all — and the label's sentence is cut
in half with a value pushed through the middle of it. `נספח א׳ §5` is the clause the twin reads, so
it is worth a second pass rather than a carry line.

**A baseline stops being a line on such a page.** `splitColumns` looks for a corridor: a vertical gap
at least as wide as `joinRow`'s own column gap, with at least three lines on each side and almost
nothing crossing it. Found, each column is assembled into **cells** rather than rows — lines a normal
line-height apart are one cell that wrapped, a bigger step down the page is the next row of the table
— and each label takes the value cell beside it. Not found, the page is read exactly as it was
before, which is every page of prose in the document.

**It is a heuristic and it says so.** The threshold for "the next row" is two glyph heights, a blank
line's worth, because a one-line cell offers no line pitch to measure. The test that pins it builds
the braid out of geometry and asserts it is gone; the document that decides whether it generalises is
the real 38-page lease, re-ingested on staging.

### A heading is not a clause

`§6` on its own is the line *"6. מטרת השכירות וייחודה"* and nothing else. On the real lease it
came **seventh for a question about rent**, on a shared word and no content — retrieval that can
return a heading is retrieval that can answer a question with a table of contents.

A bare parent heading therefore folds into the first sub-clause it heads. The reference becomes
the child's, because that is where the text is, and the heading is kept in `heading` so a caller
can show the context without citing it. An annex heading is not folded: it is not a parent in
the numbering sense, and merging it would cite the annex's preamble as the clause about the
term.

### What a chunk points at

`clause_ref` is what a citation will say — `נספח א׳ §3.2`, `§14.1`, `נספח י״ב §2`. The annex
is carried as a prefix because clause numbering restarts inside each annex, so `§3` alone
names three different clauses in one lease.

`page_from` / `page_to` are the location a human checks the citation against, and are why a
chunk is traceable rather than merely attributed. A clause that runs across a page break keeps
one chunk and two page numbers.

`clause_ref` is **nullable, and null is honest**: a cover page, a preamble, a signature block
and a table of contents have no clause number. A chunk that invented one would be a citation
pointing at nothing, which is worse than a chunk that says where it is on the page and no more.

### Splitting is by clause first and length second

A clause becomes one chunk. A clause longer than the cap is split on its own sub-numbering,
and each part keeps the parent's `clause_ref` with a part suffix — so an over-long §14 cites
as `§14.1`, `§14.2` if it has sub-clauses, and `§14 (1/3)` if it does not. Length never
silently decides where a citation points.

### Idempotent by replacement — unlike a document

11.2's finding was that `attachDocument` is *not* idempotent, because a re-upload is usually a
correction and discarding it would lose the correction. Chunks are the opposite case: they are
**derived** data with a natural key, `UNIQUE (document_id, ordinal)`. Re-ingesting the same
document is the same document read again, so `ingestDocument` deletes that document's chunks
and re-inserts them in one transaction. Either the whole re-read lands or none of it does; a
half-replaced document — some clauses from this pass, some from the last — is the shape that
would make a citation point at text no longer beside it.

This is the one place in the module that deletes rows, and it is deliberate that it deletes
only *derived* rows. Nothing a human wrote is removable here any more than it was in 11.2.

**A re-read replaces everything derived from the document, which is chunks, embeddings *and*
fields.** Slice 14.1c: the facts of `occupancy_lease_facts` are deleted in the same transaction
and before the chunks they cite. They are derived data one level further out — a field is read
*out of* a clause, and a re-read moves the text, so a fact kept across one is a citation
pointing at nothing. `0013` said so in its own comment from the day it was written
(*"re-ingesting a document deletes its chunks, which is why extraction is replaced with them
rather than left pointing at text that has moved"*) and the code did not do it: `chunk_id` is
`ON DELETE RESTRICT`, so between 13.1 and 14.1c **a document that had been extracted could not
be ingested again at all** — the re-read failed as a raw `23503` and the operator saw a 500.

**Reviews are untouched, and that is the point rather than an omission.** A review is the one
row here that is not derived (13.2), and it has no foreign key to either the fact or the chunk
— so it survives the re-read and reports `stands: false` until somebody extracts again. A
re-read is exactly the event `stands` exists to describe.

### An incomplete lease says so, and keeps saying it

Pages with no readable text are **counted, named and stored**, never dropped.

**"No text layer" is the wrong test, and the real lease proved it.** The first cut flagged a
page only when it yielded *zero* text items, and reported *"בכל העמודים נמצא טקסט"* — every
page readable — for the document the reference note measured as having four image-only pages.
The floor plan and the spec cover each carry a running footer, so each yielded one item and
passed for a page of prose. A **false all-clear on an incomplete document** is worse than
saying nothing: the operator reading an answer out of it has been told there is nothing
missing. The bar is `minPageChars` of readable text, and a page under it is dropped rather
than chunked — which takes the footer with it, since `- 15 -` on the end of a clause is a page
number pretending to be part of a contract. The reference note
warns that a complete lease is not one file — two annexes say their content was emailed
separately, and the handover protocol was blank — so ingestion must "expect an incomplete
document and say so, rather than treating absence as 'no guarantee exists'".

OCR for those pages **was** week 3's stated cut line with a manual-entry fallback, and is now a
requirement (`docs/decisions/ADR-0002-ocr-is-required.md`): a second real lease measured five
pages, every one image-only, so a document this reader cannot read is not the exception the cut
line assumed. What ingestion must not do, either way, is return a lease that is quietly four
pages shorter than the lease.

**Returning the fact is not enough, and the first cut of 12.1 proved it.** `ingestDocument`
computed the missing pages, handed them back, and the browser redirect dropped them on the
floor — so the property existed for the length of one HTTP response and nothing could ever
show it again. Three columns on `occupancy_documents` keep it instead:

| column | holds |
|---|---|
| `ingested_at` | when the document was last read, or `NULL` for never |
| `page_count` | how many pages the reader saw |
| `image_only_pages` | the pages that carried no text layer |

`ingested_at` is also the honest answer to "has this been read", which a chunk count is not: a
document read that produced **zero** chunks and a document nobody has read look identical from
a count and are not the same fact.

### Extraction is the kernel's, clause vocabulary is this module's

`PdfText` (`src/kernel/pdf.ts`) hands back positioned text items per page and knows nothing
about leases — the same footing `objects.ts` stands on. `internal/clauses.ts` turns those items
into chunks, and is pure: no clock, no pool, no store, as `roles.ts` and `paths.ts` are. The
Hebrew that identifies a clause is domain vocabulary and lives here.

The pure half is where the tests are, because it is where the failures are: RTL line assembly,
the two-column pairing, an annex boundary, a page break inside a clause. Its fixtures are
built to the *structure* the reference note documents, with invented content — no line of the
real lease is copied into this repo.

### Commands

#### `ingestDocument({ documentId }, actor) → Ingestion`

```
{ documentId, tenancyId, chunks: number, pages: number, imageOnlyPages: number[] }
```

The same three facts are written onto the document row, in the transaction that replaces the
chunks, so the screen can still say them tomorrow.

Unknown document → `not_found`. A row whose object has gone → `unavailable`, the same answer
`readDocument` gives, never a document of zero chunks. A PDF that cannot be parsed at all →
`invalid`, from the kernel adapter and not from a driver stack.

Audited, with the document as its subject. **No chunk text reaches the audit row** — the row
records that a document was ingested and how many clauses came out, which is what an operator
needs and is not a second copy of a real contract in a second table.

#### `listChunks(documentId) → Chunk[]`

By `ordinal`. The verify read for this slice and the input to 13.1. Unaudited here, as this
module's other reads are; `staff` audits its own use, exactly as it does for the document
bytes.

### Not triggered by upload, and that is recorded

`attachDocument` does not ingest. The real lease was already in the bucket before this slice
existed, so an ingest-an-existing-document path was needed regardless — and a 38-page
extraction inside the upload request makes a browser wait on it for no gain. Auto-ingest on
attach is deferred, not forgotten; it wants the kernel's durable work (`work.ts`), which is
its own slice.

## Retrieval (slice 12.2)

12.1 cut the lease into clauses. This slice makes them findable, and it is where SPEC.md's
**"absolute tenant isolation enforced at the query layer"** stops being a sentence about
`resolveByPhone` and becomes a `WHERE` clause on a vector search.

| Table | Holds |
|---|---|
| `occupancy_chunk_embeddings` | `chunk_id`, `tenancy_id`, `model`, `embedding vector(1536)`, `created_at` |

Migration `0012_embeddings.sql`.

### The filter is a column, which is the whole point

`tenancy_id` was put on the chunk row in 12.1 *for this slice*, and it is carried onto the
embedding row for the same reason: **every retrieval query filters by occupancy, and a filter on a
column of the table being searched is one a query cannot be written without noticing.** A filter
that needs a join back to `occupancy_documents` is a join a later query can omit, and the query
that omits it answers one tenant with another's lease.

`searchClauses` takes `tenancyId` as a **required argument**. There is no default, no optional
parameter and no code path that searches every lease — an "all tenancies" search is not a feature
this module declines to expose, it is a shape that does not exist here.

### Keyed by model, so a model change is not a rewrite

The primary key is `(chunk_id, model)`. Re-embedding under a new model id must not touch the
clause rows, and during a change both sets have to exist at once — the old one still answering
questions while the new one is built. `ON DELETE CASCADE` to the chunk is the only cascade in this
module and it is deliberate: an embedding is derived from a clause and is meaningless without it,
which is the opposite of the dangling-reference argument that makes everything else `RESTRICT`.

### Embedding is part of ingesting, not a second button

`ingestDocument` embeds the chunks it just cut and writes both together. Reading a document and
indexing it are one operation from the operator's side, and splitting them would create a state —
chunks with no vectors — that looks identical to "indexed" on every screen that counts clauses.

**The embedding happens before the transaction opens, not inside it.** It is a network call to a
third party, and holding a Postgres transaction open across one is how a slow provider becomes a
lock nobody can explain. The guarantee survives the ordering: a failed embedding throws before a
single row is deleted, so the previous pass is still intact and a document is never half-indexed.
The transaction then writes clauses and vectors together, which is what stops a crash between them
leaving clauses nothing can find.

It also means ingestion now takes as long as the embedding calls, which is the cost of the
guarantee and is stated rather than hidden.

### `searchClauses({ tenancyId, query, limit }) → ClauseHit[]`

The query text is embedded through the same `Embedder` the chunks were, then ranked by cosine
distance within the tenancy. A hit carries what a citation needs — `clauseRef`, `pageFrom`,
`pageTo`, the text, and the distance — so the caller can cite rather than paraphrase.

An unknown or wrong `tenancyId` returns **an empty list, not `not_found`**. A tenancy that has no
indexed lease and a tenancy that is not yours must look identical from the outside: a distinct
error would confirm the tenancy exists, which is an isolation leak wearing an error code.

Unaudited here, as this module's other reads are. Its callers audit their own use.

### Measured, slice 14.1a: ranking is not ordered, and a refusal cannot be a distance cutoff

`searchClauses` is unchanged by 14.1a. What that slice added is the instrument that measures it,
and three findings that constrain what 14.1b may do. Full numbers in
`tasks/evidence/day-14-ranking.md`.

**A long heterogeneous chunk is a universal attractor, and this is now reproduced rather than
suspected.** On an independent 19-chunk fixture, the front page — parties, ID numbers, a phone, an
email, two addresses, a parcel number — is in the top 3 for half the probes, on questions with
nothing to do with any of it. It **beats the clause that states the lease term** (`0.358` against
`0.454`) and trails the rent clause by `0.008`. It reproduced at 19 chunks as well as at 221, so it
is a property of the chunk and not of the corpus size.

**That is a privacy finding as much as an accuracy one.** The chunk most likely to be retrieved for
a vague question is the PII-densest text in the document, and it carries `clauseRef: null` — so
nothing can cite it, and the only thing left to do with it is feed it to a model. Week 4 does
exactly that with top hits.

**No single distance threshold separates a right answer from a wrong one.** Across the same probes
the worst answering clause scored `0.652` and the best non-answer `0.358` — an overlap of `0.294`,
not a marginal one. A refusal of the form *"refuse when nothing scores below T"* is therefore not
buildable on this signal, which is why 14.1 was split before any code was written: the refusal rule
and the ranking defect are one problem.

**Rank is stable across runs; distance is not.** Re-embedding the same text moves a distance by up
to `0.006` (mean `0.001`, 48 paired observations) while leaving every rank identical. Anything that
asserts on retrieval — a golden case, a threshold, a screen — must read order and not magnitude.

### Decided, slice 14.1b: an uncitable chunk is stored and never indexed

14.1a's attractor is not down-weighted, re-cut or re-scored. **A chunk with no clause reference is
not embedded at all**, so it cannot be retrieved, and the text it holds never leaves this
infrastructure.

The argument is one argument wearing two hats, and both were measured rather than assumed:

- **Accuracy.** The front page is a long heterogeneous chunk that sits close to every question. It
  won a question about the lease term outright. Nothing downstream could ever have used it: a
  citation cannot name it, and this system's whole stance is that an answer is only as good as the
  clause it points at.
- **Privacy.** It is also the PII-densest text in the document — both parties' names, two ID
  numbers, a phone, an email, two addresses. Not embedding it means those never reach the embedding
  provider. This is the **identical rule `twin.ts` already applies to extraction** (see "Which
  clauses are sent is decided by clause reference, never by similarity"), reached from the other
  direction: selection requires a clause number, the front page has none.

**Stored, not indexed** — the distinction is the whole design. `ingestDocument` still writes every
chunk row, so `listChunks` still shows the front page, the document's text is still complete on the
screen, and `page_count` / `image_only_pages` still describe the real document. What changes is
which rows get a vector.

**A chunk that says nothing but its own heading is not indexed either.** `נספח א׳` on its own is
the line `נספח א׳ — פרטי העסקה`; retrieval that can return it is retrieval that can answer a question
with a table of contents — the argument 12.1 already made for a bare parent heading (`§6`). It is
**not folded** into the annex's first clause: 12.1's decision stands, because an annex heading is not
the parent of the clauses inside it and merging them would cite an annex's preamble as the clause
about the term. An annex that *has* a preamble says more than its heading and stays indexed; one
that is a title and a page break does not.

**Reversing it is a re-ingest, not a migration.** Ingestion is idempotent by replacement, so a
document read again under a later rule is simply re-indexed. A document *not* re-read keeps the
vectors it already has — stated because it means the rule holds for documents ingested from here,
and the fleet is made consistent by re-ingesting rather than by a backfill.

### What is deliberately not here

- **Ranking across lease → policy → refuse.** `channel`'s, as of 14.1b: it composes this command
  with `catalog`'s policy search, because ordering two corpora is neither module's business. This
  command searches one tenancy's documents and stops.
- **An answer.** `searchClauses` returns clauses, not prose. The agent that turns them into a
  Hebrew sentence with a citation is week 4, and SPEC.md rule 2 keeps it a client of this command.
- **Re-embedding on a model change.** The table can hold two models at once; nothing orchestrates
  moving between them.

## The digital twin (slice 13.1)

12.1 cut the lease into clauses and 12.2 made them findable. Neither lets this system **state a
fact about the tenancy**: when the term ends, what the rent rule is, what was deposited. Those
live as prose inside a clause, and week 4's agent and week 5's cases both need them as fields.

This slice extracts them, and its one hard rule is that **a field is only ever as good as the
clause it points at**. Every stored field carries the chunk it came from, so an operator — and
13.2's reviewer — can read the value against the text that produced it.

| Table | Holds |
|---|---|
| `occupancy_lease_facts` | `id`, `document_id`, `tenancy_id`, `field`, `value`, `chunk_id`, `clause_ref`, `page_from`, `page_to`, `confidence`, `model`, `extracted_at` |

Migration `0013_occupancy_lease_facts.sql`. `ON DELETE RESTRICT` to all three parents, as
everything else in this module is.

### `tenancy_id` is on the row for the third time, and for the third time it is the same argument

It is reachable through `document_id`. It is stored anyway, exactly as it is on the chunk row and
on the embedding row: **every read of a tenant's facts filters by occupancy**, and a filter on a
column of the table being read is one a query cannot be written without noticing. A filter that
needs a join back to `occupancy_documents` is a join a later query can be written without, and
that query answers one tenant with another tenant's lease.

The value is copied from the document row at extraction time and is never taken from a caller,
for the reason 12.1 gives: a document never moves between tenancies.

### The five fields, and the two that rule 7 shapes

| `field` | `value` |
|---|---|
| `term` | `{ initial: { from, to }, options: [{ from, to, noticeBy }], capYears }` |
| `rent` | `{ baseAmount, currency, indexBaseMonth, rule }` |
| `securities` | `[{ kind, statedAmount?, statedText }]` — deposit, bank guarantee, שטר חוב |
| `notice` | `[{ event, days }]` — the window before each rollover, and on exit |
| `deductibles` | `[{ subject, statedText }]` |

**`term` cannot hold a single end date**, and that is the point. The lease is an initial period
plus two options capped at ten years overall (`docs/reference/lease-template-donadom.md`), and
`occupancy_tenancies.ends_on` is deliberately "the end of the term currently in force" rather
than the lease's ultimate expiry — see "What current means" above. The twin is where the whole
structure lives, which is why one date range is enough there and is not enough here.

**`rent` cannot hold a rent.** It holds the base figure the contract states, the index it is
linked to, the base month it is measured from, and the re-basing rule in the lease's own words.
SPEC.md rule 7 is not enforced here by a convention that nobody computes a charge — it is
enforced by a stored shape with **nowhere to put one**. The same is true of `deductibles`, which
carries the clause's stated text and never a figure this system derived.

`statedAmount` on a security is the number the contract prints, kept as text with its currency,
because a deposit written in the lease is a fact about the document rather than a sum this
system is doing arithmetic on.

### The vocabulary is expected to grow, so it is code and not a `CHECK`

Every other closed vocabulary in this schema is a `CHECK` constraint — party roles, document
kinds, staff roles. This one is not, and the exception is deliberate: the five fields above are
the five week 3 needs, and more will be defined as the product finds out what it has to answer.
A `CHECK` would make each new field a migration whose entire content is a second copy of a list
the code already enforces, and the two copies would drift.

`internal/twin.ts` holds the registry — the field name, the shape of its value, the clauses worth
sending, and the schema the model is held to — and it is the module's single statement of what a
lease field is. Adding a field is an entry there and a test, not a migration.

### Which clauses are sent is decided by clause reference, never by similarity

The chunks fed to the model are selected deterministically in `twin.ts`: by annex and clause
number for the fields the annex holds, and by keyword over clause text for the ones the body
holds. `searchClauses` is not used, and that is not an oversight — day 12 measured retrieval
ranking as **not yet good enough** and carried it to 14.1 with a diagnosis. A twin built on a
ranking that is known to be wrong would inherit the problem invisibly; a twin built on
`נספח א׳ §5` by name is reading the clause the reference note says to read.

**It is also a privacy decision, taken here rather than inherited.** The front page is the
PII-densest text in the document — two names, two ID numbers, two phones, an email — and 12.2
measured it as the chunk most likely to be retrieved for any vague question. It carries no clause
number, and selection here requires one, so **the front page is never sent to the model at all**.
That is a property of the selection rule and is asserted by a test, not a habit.

### One call per field, and the calls run together

Five calls, each carrying only the clauses that field could be in, each held to only that field's
schema. The input stays about one question rather than being a lease pasted into a prompt, and the
sixth field, when it is defined, is a registry entry rather than a longer prompt.

**They are issued concurrently, and the first cut of this slice got that wrong.** The fields are
independent, so running them in sequence made the request cost their *sum* — and on the real lease
that sum passed Cloud Run's 300-second request timeout, so the operator's first press produced a
blank page and no twin. Concurrently the request costs the slowest call. The kernel's per-call
timeout is the other half of that fix (`SPEC-kernel.md`, "Bounded, because the caller is a browser
request"), and neither half makes this work belong in a browser request: that is `work.ts`, and
its own slice.

**Every call must come back, though.** A pass replaces the document's facts wholesale, so a pass
with a failed call is not a pass: the command throws and nothing is deleted, which leaves the
previous extraction intact. That is 12.2's guarantee for a failed embedding, and it is here for
the same reason — the alternative is a twin missing the one field whose call happened to fail,
indistinguishable on screen from a lease that is silent about it.

### A citation naming a clause that was not sent is rejected

The model returns a `chunkId` with every field. It is checked against the exact set of chunks
that call was given, and a field whose citation is not in that set is **dropped rather than
stored**.

This is the load-bearing rule of the slice. A wrong value with an honest citation is a
correction 13.2 can make, and the operator reading it can see what the model saw. A value with an
invented citation is worse than no value at all, because every screen downstream renders it as
grounded — the same argument 12.1 makes for `clause_ref` being nullable: a chunk that invented a
clause number would be a citation pointing at nothing.

**A list's rows each carry their own citation.** `securities`, `notice` and `deductibles` are
lists, and their rows come from different clauses — a list citing one clause for all of them would
be a false citation for every row but one. So each row names its own chunk, checked by the same
rule, and a row whose citation was not sent is dropped while the rest of the list stands. The
field's own citation is the clause the field as a whole was read from.

`confidence` is stored as **what the model said about itself**, and is named that way rather than
`certainty` so nothing downstream mistakes it for a measurement of ours.

### Idempotent by replacement, like chunks and unlike a document

Facts are derived data with a natural key, `UNIQUE (document_id, field)`. Re-extracting is the
same document read again, so `extractTwin` deletes that document's facts and re-inserts them in
one transaction — 12.1's argument exactly, and the same guarantee: either the whole pass lands or
none of it does.

**What 13.2 has to know before it builds confirmation:** a confirmation is a human's statement
about *a value*, so a re-extraction that produces a different value must not leave the old
confirmation standing beside the new number. The columns that record who confirmed what are
13.2's, and so is that rule; it is written here because this is the slice where the shape it
constrains was decided.

### Commands

#### `extractTwin({ documentId }, actor) -> Extraction`

```
{ documentId, tenancyId, fields: number, attempted: number, model }
```

Unknown document -> `not_found`. A document with no chunks -> `invalid`: extraction reads clauses
and there is nothing to read, which is a different fact from a lease that says nothing about its
term. A model reply that is not the schema, or a call that fails -> `unavailable`, from the kernel
adapter, before a single row is deleted.

Audited, with the document as its subject. **No field values reach the audit row** — the row says
a document was read and how many fields came out, which is what an operator needs and is not a
third copy of a real contract's contents (12.1's rule, and `tasks/fuses.md` counts the places).

#### `listLeaseFacts(documentId) -> LeaseFact[]`

By field, in the registry's order. The verify read for this slice and the input to 13.2.
Unaudited here, as this module's other reads are; `staff` audits its own use.

## Reviewing a field (slice 13.2)

13.1 ends with five fields on a screen and a sentence saying they are unreviewed. This slice
is the surface that ends that sentence: an operator **confirms** a field or **corrects** it,
and the record says who did which, to what value, and when.

| Table | Holds |
|---|---|
| `occupancy_lease_field_reviews` | `id`, `document_id`, `tenancy_id`, `field`, `decision`, `value`, `reviewed_value`, `reviewed_by_kind`, `reviewed_by_id`, `reviewed_at` |

Migration `0015_occupancy_lease_field_reviews.sql`. `ON DELETE RESTRICT` to the document and
the tenancy, as everything else in this module is — and **to nothing else**, which is the
next section.

### A review is not derived data, so it is not a column on the fact

Every other row this module has added since 12.1 is derived: a chunk, an embedding, a fact.
Each is replaced wholesale when the thing above it is read again, and each says so. A review
is the one row here that a machine did not produce, and it must survive the button that
replaces the rest.

That rules out the obvious shape. Confirmation columns on `occupancy_lease_facts` would be
deleted by the next `extractTwin`, because that command deletes the document's facts and
re-inserts them — a human's statement erased by someone pressing "read again", with nothing
on the screen to show it ever existed. So the review is its own table, keyed
`UNIQUE (document_id, field)`, and it holds **no foreign key to the fact or to the chunk**:
both are replaced on every re-read, and a `RESTRICT` to either would make a review able to
block a re-extraction, while a `CASCADE` would make it able to be silently erased by one.

### `stands`, and what a re-extraction does to a confirmation

13.1 stated the rule this slice had to honour: *a confirmation is a human's statement about a
value, so a re-extraction that produces a different value must not leave the old confirmation
standing beside the new number.*

It is honoured by storing what the statement was about. `reviewed_value` is the extracted
value at the moment of review, and `listFieldReviews` reports

```
stands = the document's current fact for this field exists, and its value = reviewed_value
```

as a `jsonb` comparison in SQL, where key order is already normalised. A re-extraction that
returns the same value leaves the confirmation standing — the office does not re-confirm five
fields because someone pressed a button. One that returns a different value, or none at all,
leaves the review **superseded**: it is still in the table, still says who reviewed what, and
the field counts as unreviewed until someone looks again. Deleting it would have satisfied the
rule too, and would have thrown away the only evidence that the value used to be different.

### The value of record

Where a review stands, **its value is the value of record** and the extraction is the working
that produced it. `listLeaseFacts` and `listFieldReviews` return the two halves separately
because they have different authors; anything that answers a question about this tenancy --
week 4's agent first — reads the standing review's value when there is one, and the fact's
value only when there is not. The citation is the fact's either way: a review does not carry
one.

### A correction may change a value and may never change a citation

A correction is applied to the value the extraction stored, server-side, from the fact read
inside the command. It is expressed as **edits to the leaves of that value and rows to drop**,
never as a value posted whole: a caller that could post a value could post a value with a
citation nobody checked, which is 13.1's rejected-citation rule arriving from the other side.

`internal/edits.ts` holds that, pure, beside `twin.ts`: `editableGroups` walks a stored value
into the scalars a human may change — skipping `chunkId` and `clauseRef` on every row, which
are shown and are not editable — and `applyEdits` puts the changes back. A path the stored
value does not have is ignored rather than created, so the form cannot invent structure.

The result then goes through `leaseFieldSpec(field).parse` with **the document's own chunks**
as the sent-set, which is the same function and the same check the model's reply passed: a row
whose `chunkId` does not name a clause of this document is dropped, and `clauseRef` is
re-derived from the chunk rather than taken from the caller. A human correcting a field is held
to exactly the citation rule the model was.

That works because `parse` accepts its own output. It maps the model's reply shape to the
stored shape, and as of this slice it also accepts the stored shape unchanged — `initial.from`
as well as `initialFrom`, `{ items: [...] }` as well as a bare array. Idempotence is asserted
per field as a property test rather than left as an intention, because it is what makes a
correction a round trip instead of a second parser.

### The fact id is a version token, not an id the caller is trusted with

Confirming is a statement about the value on the screen, so the form carries the id of the fact
it is looking at, and the command refuses with `conflict` when the document's current fact for
that field is a different row. Re-extraction mints new fact ids, so this catches exactly the
case that matters: someone re-read the lease between the render and the press, and the operator
would otherwise be confirming a value they never saw. Nothing else comes from the caller --
the tenancy, the value and the citation are all read server-side.

### Commands

#### `reviewLeaseField({ documentId, field, factId, decision, edits?, drops? }, actor) -> LeaseFieldReview`

`decision` is `confirmed` or `corrected` — a `CHECK` in the schema, unlike `field`, because
this vocabulary is not the one that was stated to be growing. A confirmation takes no edits and
copies the fact's value; a correction applies its edits and drops and is refused as `invalid`
if what comes out is not a value this field can hold — including the correction that drops
every row, which is a deletion, and there is no way to delete a field.

Unknown document or no fact for that field -> `not_found`. A field outside the registry ->
`invalid`. A fact id that is not the current one -> `conflict`. Upsert on the natural key: a
field reviewed twice has one review, the later one.

Audited, with the document as its subject. `inputs` carries the field and the decision and
**no values** — the review table is now the fifth place a real contract's text lives
(`tasks/fuses.md` counts them) and `audit_log` is not going to be the sixth.

#### `listFieldReviews(documentId) -> LeaseFieldReview[]`

By field, in the registry's order, each with `stands`. Unaudited here, as this module's other
reads are; `staff` audits its own use, on the same read as the clauses and the facts.

## Audited

`openTenancy`, `addParty` and `endTenancy` are wrapped in the kernel's `audit.around`, so a
row is written whether the command succeeds or throws. Edge validation runs **inside** the
audited work, so a rejected command leaves an `error` row rather than no row.

`openTenancy` has no subject id — the tenancy it names may not exist yet, and on a repeat the
caller gets the existing tenancy, whose id is not the one this call would have minted. Its
unit id is in `inputs`. The other two take the `tenancyId` as their subject.

## Not yet in place

- **Overlapping tenancies on one unit are not prevented in general.** `UNIQUE (unit_id,
  starts_on)` stops the case that matters — a re-run import creating a second copy — but two
  tenancies with different start dates and overlapping ranges are still insertable. The
  schema-level fix is an exclusion constraint over a `daterange`, which needs the
  `btree_gist` extension; whether the Cloud SQL runtime user may `CREATE EXTENSION` is
  unverified, and finding out is its own slice rather than a guess inside this one.
- **Reads are not audited.** `resolveByPhone`, `getTenancy` and `findCurrentTenancy` write
  nothing. Their callers audit their own use — as of 10.1 `staff` does exactly that, writing a
  row when an operator *opens* a unit and none when a list is rendered (`SPEC-staff.md`) — and
  a broader PII-read trail is a week-6 concern, the same position `identity` takes.
- **Nothing outside `staff` reads a document, a chunk or a fact.** 11.2 stored the lease,
  12.1 cut it into clauses, 12.2 made them findable and 13.1 turned the annex into fields —
  and every one of those is reached today by a staff session and by nothing else.
  `tenancyAccess` is still the value that will scope a tenant-facing read, and the agent that
  does the reading is week 4.
- **Ingestion is manual and synchronous.** An operator presses a button and the request waits
  on a 38-page extraction. Auto-ingest on attach wants the kernel's durable work (`work.ts`)
  so an upload is not held open by it, and that is its own slice.
- **A chunk's boundaries are a heuristic, not a parse.** `clauses.ts` reads numbering, annex
  headers and column geometry; it does not understand the document. A lease laid out unlike
  the tender's scheme will chunk worse, and the honest place to find that out is a second
  real lease — which is why the reference note says to treat one sample's specifics as
  unconfirmed.
- **No rent, no money, ever.** SPEC.md rule 7. The twin (13.1) stores the *parts* of the
  lease's rent formula — the base figure the contract prints, the index, the base month, the
  re-basing rule in the lease's words — and has nowhere to put a figure this system computed.
  Reading a charge out of them is not deferred work; it is work this module will never do.
- **No "unconfirmed" party↔phone mapping.** The lease sample carries two tenants and two
  mobile numbers with nothing saying which is whose. An importer must be able to record that
  honestly rather than guess — guessing wrong inside a household is recoverable, guessing
  wrong across households is the isolation failure. That belongs in slice 8.1, where the real
  file is.
- **`validDate` / `optionalDate` are on the contract as of slice 8.1.** The importer must
  reject `2026-02-30` before it writes rather than after, and a second copy of the rule in
  the importer would drift from the one these commands enforce. Behaviour unchanged.
- **A tenancy with two documents has two twins, and nothing chooses between them.** Facts
  are keyed by document, because a re-upload is a correction rather than a version (11.2) and
  silently preferring one document's answer would be preferring the wrong one half the time.
  13.2 was expected to settle this, on the reasoning that the screen which confirms a field is
  where a human is present to say which document is authoritative — and it did not. Reviews
  are keyed by document as well, so a tenancy with two documents now carries two *reviewed*
  twins and still nothing chooses between them. The choice needs a read that answers about a
  tenancy rather than about a document, and the honest place for it is the slice that first
  has to ask that question, which is week 4's.
- **Extraction is manual and synchronous.** An operator presses a button and waits on five
  model calls; nothing triggers it on ingest. Running the calls together and bounding each one
  keeps that wait inside a request that can answer, and it does not make the wait *right* — a
  model call chain on the end of a browser request wants the kernel's durable work, which is
  the same slice auto-ingest is waiting for. **Unreviewed** is no longer part of this item:
  13.2 records who confirmed or corrected each field, and a field nobody has looked at now
  says so rather than reading as settled.
- **A correction may edit and may drop, and may not add.** A reviewer can change a value the
  extraction read and can drop a row that should not be there — the two things the real lease
  actually needed. Adding a row, or filling in a leaf the extraction left null, is refused
  rather than half-built: both are *stating* something the model did not, so both need a
  citation the reviewer has to choose, and choosing a clause is a surface this screen does not
  have. The reviewer's answer today is to correct a row that exists, or to leave the field
  unconfirmed.
- **A correction records no reason.** The review says what the value became and who made it
  so, never why — and the why is the sentence that would turn a correction into a golden case
  (PIPELINE.md §6). A note beside the decision, and the path from a correction to
  `evals/golden/`, are one slice and are worth doing as one.
- **Nothing is removable.** No way to detach a party or delete a tenancy; corrections to
  anything other than a lease field are a manual database task until an admin screen owns
  them.
