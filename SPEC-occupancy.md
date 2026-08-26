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
scan arrives as a PDF too; OCR is the week-3 cut line, logged as manual entry.

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

OCR for those pages is week 3's stated cut line (`ROADMAP.md`), logged as a manual-entry
fallback. What ingestion must not do is return a lease that is quietly four pages shorter than
the lease.

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

### What is deliberately not here

- **Ranking across lease → policy → refuse.** Slice 14.1. This searches one tenancy's documents
  and stops.
- **An answer.** `searchClauses` returns clauses, not prose. The agent that turns them into a
  Hebrew sentence with a citation is week 4, and SPEC.md rule 2 keeps it a client of this command.
- **Re-embedding on a model change.** The table can hold two models at once; nothing orchestrates
  moving between them.

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
- **A document is chunked, not yet retrievable.** Slice 11.2 stored and served it and 12.1
  cut it into clauses; embeddings scoped by occupancy (12.2) and the extracted twin (13.1)
  are the slices that make it answerable. `tenancyAccess` is still the value that will scope
  the retrieval, and nothing reads a document or a chunk by anything but a staff session yet.
- **Ingestion is manual and synchronous.** An operator presses a button and the request waits
  on a 38-page extraction. Auto-ingest on attach wants the kernel's durable work (`work.ts`)
  so an upload is not held open by it, and that is its own slice.
- **A chunk's boundaries are a heuristic, not a parse.** `clauses.ts` reads numbering, annex
  headers and column geometry; it does not understand the document. A lease laid out unlike
  the tender's scheme will chunk worse, and the honest place to find that out is a second
  real lease — which is why the reference note says to treat one sample's specifics as
  unconfirmed.
- **No rent, no money, ever.** SPEC.md rule 7. The lease's rent is an index-linked formula
  against a named base month, which is the week-3 twin's problem and never this module's.
- **No "unconfirmed" party↔phone mapping.** The lease sample carries two tenants and two
  mobile numbers with nothing saying which is whose. An importer must be able to record that
  honestly rather than guess — guessing wrong inside a household is recoverable, guessing
  wrong across households is the isolation failure. That belongs in slice 8.1, where the real
  file is.
- **`validDate` / `optionalDate` are on the contract as of slice 8.1.** The importer must
  reject `2026-02-30` before it writes rather than after, and a second copy of the rule in
  the importer would drift from the one these commands enforce. Behaviour unchanged.
- **Nothing is removable.** No way to detach a party or delete a tenancy; corrections are a
  manual database task until an admin screen owns them.
