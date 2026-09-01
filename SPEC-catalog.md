# SPEC: catalog

Conventions inherited from SPEC.md. The module that holds **what the company says**, as opposed
to what a particular contract says.

- **Responsibility:** Job types, rates, who-pays/deductible rules, self-service how-tos, and —
  since slice 14.1b — **guidance documents: the office's own policy text, retrievable and citable**
- **Depends on:** —
- **Commands:** `syncGuidance` · `searchGuidance` · `listGuidance`
- **Events:** none yet
- **Status:** the guidance half is built (14.1b). Job types, rates and deductible rules are week 5
  and this spec still says nothing about them.

## Guidance documents (slice 14.1b)

Week 3's question is "what does the lease say". This module answers the other one: **what does the
office say, when the lease says nothing**. An off-lease question — when is the office open, how is
an emergency reported, how is entry to a flat arranged — has an answer, and today that answer lives
in someone's head.

### Why it cannot live in `occupancy`

A lease belongs to one tenancy. A policy belongs to the company. Putting policy text in
`occupancy_document_chunks` would mean a **nullable `tenancy_id`**, which is exactly the shape
SPEC-occupancy.md's "the filter is a column" forbids: the moment the column can be null, a retrieval
query filtering on it either misses every policy row or is rewritten as `IS NULL OR = $1`, and the
second form is one keystroke away from returning another tenant's lease.

So policy gets its own tables, with **no `tenancy_id` at all**. The isolation rule is honoured by
the column not existing rather than by remembering to filter it, and the two corpora are ordered by
a module above both (`channel`, and SPEC-channel.md).

### Markdown we author, not a PDF someone sends

Decided 2026-09-01. Policy text is **ours**, so it belongs in the repo as a reviewable file —
`docs/guidance/*.md`, diffed like code, changed by a pull request. That is a different front door
from `occupancy`'s upload, and the gap is stated rather than glossed:

| | lease | guidance |
|---|---|---|
| arrives as | an uploaded PDF, per tenancy | a markdown file in the repo, org-wide |
| cut on | clause boundaries (`clauses.ts`) | heading boundaries (`guidance.ts`) |
| cited as | `נספח א׳ §5` | `נוהל פנייה למשרד § שעות פעילות` |
| loaded by | an operator pressing a button | `npm run guidance` |

**Everything downstream of the chunk is the same pipeline** — the same `Embedder`, the same model id
from the same config row, the same `vector(1536)` column, the same cosine search. That is the point:
one retrieval mechanism, two corpora.

### Every guidance chunk is citable, by construction

`clauses.ts` has to admit `clauseRef: null`, because a real lease has a cover page and a signature
block that genuinely carry no clause number. Markdown we write has no such thing: text before the
first `##` is cited by the document's title, and everything after it by its heading. So
`heading_ref` is `NOT NULL`, and 14.1b's "an uncitable chunk is never indexed" is satisfied here by
there being nothing uncitable to index.

**The reference is spelled by the chunker, not by whoever writes a citation** — the same rule
14.1a arrived at for clauses. `${title} § ${heading}` is computed at sync time and stored, so a
golden case, a screen and an agent all name a section the same way.

### Tables

Migration `0016_catalog_guidance.sql`. `created_at` carries no `DEFAULT now()`, as everywhere else:
time comes from the injected clock.

| Table | Holds |
|---|---|
| `catalog_guidance_documents` | `id`, `slug` (unique), `title`, `source_path`, `checksum`, `ingested_at`, `created_at` |
| `catalog_guidance_chunks` | `id`, `document_id`, `ordinal`, `heading_ref`, `heading`, `text`, `created_at` |
| `catalog_guidance_embeddings` | `chunk_id`, `model`, `embedding vector(1536)`, `created_at` |

The embedding table is keyed `(chunk_id, model)` and cascades from the chunk, for the two reasons
`occupancy_chunk_embeddings` is: a model change must be able to add a second set without touching
the text, and an embedding with no clause is meaningless. The chunk cascades from the document for
the same reason — unlike `occupancy`, where a chunk is `RESTRICT` because it points at a real
uploaded object. A guidance document's source of truth is a file in git; deleting the row loses
nothing.

### `syncGuidance(actor) → { documents, chunks, skipped }`

Reads every markdown file the source offers, and for each one:

- **checksums the file and skips it when nothing changed.** Re-embedding unchanged policy on every
  run is money spent to produce identical vectors, and the checksum is what makes `npm run guidance`
  safe to run as often as anyone likes.
- **replaces, never appends.** A changed file's chunks are deleted and re-inserted in one
  transaction, exactly as `ingestDocument` does — `(document_id, ordinal)` is the natural key, so a
  re-sync is a replacement and not a second copy. A section deleted from the markdown is a section
  the system no longer claims.
- **embeds outside the transaction**, for the reason occupancy does: a network call held inside one
  is a lock nobody can explain, and a failed embedding throws before a row is deleted.

A file the source no longer offers is **left alone**, and this is a gap rather than a decision:
nothing deletes a withdrawn policy today. Recorded in `tasks/todo.md` rather than hidden here.

Audited as `catalog.syncGuidance`, with the slug and the counts — no policy text, for the reason
occupancy's ingest audits no clause text.

### `searchGuidance({ query, limit }) → GuidanceHit[]`

The query is embedded through the same `Embedder` and ranked by cosine distance across **all**
guidance. No tenancy argument, no filter, and that is not an omission — see "Why it cannot live in
`occupancy`". A hit carries what a citation needs: the document's title, the section's `headingRef`,
the text and the distance.

Unaudited, as `occupancy`'s reads are. Its callers audit their own use.

### Not here, deliberately

- **An admin screen.** Editing policy is a pull request today. Week 5's catalog admin is where a row
  becomes editable without a deploy, and this spec will have to say what happens to a document
  edited in two places.
- **Ordering against a lease.** `channel`'s, and stated there: this command searches policy and
  stops.
- **Sync at boot.** A deploy must not depend on a call to a model provider. `npm run guidance` is a
  deliberate, human-run step, named in `docs/runbook-deploy.md`.
- **Any tenant data.** Guidance is text we wrote about our own operations. Nothing in these tables
  comes from a person, a lease or a case, which is why they need no isolation rule.
