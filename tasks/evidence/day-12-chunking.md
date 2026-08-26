# Evidence — Slice 12.1: text extraction + clause-aware chunking

Captured 2026-08-25, day 12. Staging serves `99aac93`.

**No content of the real lease is reproduced here.** Clause references and counts
only — the document holds names, ID numbers and signatures, and this file is in
the repo. Same rule `docs/reference/lease-template-donadom.md` was written under.

## The bar, and how it was met

*"The real pilot lease is chunked and every chunk points back at its clause."*
It is. Read on staging by the owner in a browser, three times, once per commit:

| commit | chunks | what changed |
|---|---|---|
| `348c74d` | 266 | first pass — body chunked, נספח א׳ did not |
| `7f0f325` | **273** | the annex form `סעיף N`, and the reading facts persisted |
| `99aac93` | 273 | the page-text threshold — no change on this document, see below |

**Verify step: five chunks spot-read against the PDF.** More than five were
checked; these are the ones that carry the argument:

| chunk | pages | what it proves |
|---|---|---|
| *(null ref)* | 1 | a preamble keeps **no** clause reference rather than an invented one |
| `§1` · `§1.1–1.2` | 1 | the body's own numbering, and short sub-clauses coalescing into a range |
| `§19.6` · `§20` | 13–14 | deep sub-numbering, and a clause spanning a page break |
| **`נספח א׳ §5`** | 14 | **the whole term structure in one citable clause** |
| **`נספח א׳ §10`** | 14–15 | **the rent and the maintenance fee, in the clause that states them** |
| `נספח ז׳ §3.1–3.2` | 24 | a second annex, chunking by its own numbering |

`נספח א׳ §5` is the one that matters most for 13.1. It holds the initial period,
both options and the ten-year cap as one clause — the shape `SPEC-occupancy.md`
says the twin must not flatten into a single end date. `§10` holds the monthly
rent, the maintenance fee and the index-linkage rule together.

## What the first pass got wrong, and the lease told us

Both findings came from running against the real document rather than our own
fixtures. That is the argument for keeping the lease (`tasks/fuses.md`), paid off
twice in one day.

**1. The annex was one blob.** 266 chunks came out and the body was right, but
נספח א׳ — the annex the twin reads — was a single chunk split by length, cited
`נספח א׳ (1/2)` across pages 14–15. The body numbers clauses `1.`, `3.2` at the
start of a line; the annexes write `סעיף 5 – …`, naming the body clause each row
qualifies. That form was invisible. A citation naming two pages is not a citation
a twin can be built on. Fixed in [#21](https://github.com/RandomWilder/dona-v3/pull/21).

**2. A property that lived for one HTTP response.** `ingestDocument` computed
which pages carried no text layer, returned them, and the browser redirect
dropped them — while `SPEC-staff.md` claimed the screen showed them. Three
columns on `occupancy_documents` keep them now. Also in
[#21](https://github.com/RandomWilder/dona-v3/pull/21).

## The image-only pages: measured, and still not detected

The chunks page reads:

```
נקרא 25.08.2026 · 38 עמודים · בכל העמודים נמצא טקסט
```

38 matches the reference note's measured page count, so the reader saw the whole
document. The rest of that line is **wrong, and knowingly left standing.**

`docs/reference/lease-template-donadom.md` measured **four image-only pages** —
the placeholder, the floor plan, the spec cover, one page of tables.
[#22](https://github.com/RandomWilder/dona-v3/pull/22) raised the bar from "yields
zero text items" to "yields under `minPageChars` of readable text", and the count
of flagged pages stayed at zero. The logs prove that pass ran on the new code:

```
15:50:18  POST .../ingest  302  2.9s  dona-staging-00033-nls
revision  dona-staging-00033-nls created 15:47:48
boot      dona-v3 99aac93 … docs: gs://dona-v3-staging-docs
```

So **every page of this lease carries at least 40 characters of text.** Those four
pages are not blank of text: they carry a title block, a caption, a header. The
note's "image-only" means *the page's content is a picture*; the code measures
*how much text a page yields*. They are different properties, and no third
threshold bridges them — which is why a third one was not chosen.

The consequence is recorded rather than papered over: the screen asserts an
all-clear it cannot support. Real detection needs a different signal — whether a
page's drawing operators are dominated by a full-page image — and that is its own
slice, carried to day 13.

## What only staging could prove

Two things no test reaches, both shown:

- **pdfjs reads Hebrew from the real document**, in logical order, with the annex
  layout intact. The largest unknown in the week-3 plan, closed by measurement.
- **The re-read path replaces rather than duplicates**, against 266 real chunks:
  three ingests of one document, and the document has one set of chunks.

## The audit trail

Five ingest POSTs, all `302`, spread across three revisions — every one of them a
`staff.ingestDocument` row with the capability recorded and an
`occupancy.ingestDocument` row naming the document and no text out of it. The
clause text is in `occupancy_document_chunks` and nowhere else in the database,
which is what `tasks/fuses.md` now holds the sign-off deadline on.
