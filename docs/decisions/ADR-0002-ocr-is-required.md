# ADR-0002 — Scanned leases are read by OCR, not typed by hand

- **Date:** 2026-08-31
- **Status:** accepted
- **Context slice:** measured after 13.1, on the second real lease

## Context

Week 3's plan carried OCR as a **cut line**: *"OCR for scanned PDFs (log as
manual-entry fallback)"* (`ROADMAP.md`), and the risk register named the same
mitigation for a foreseen risk — *"Lease PDFs are scans / messy | High |
Extraction review UI + manual field entry fallback (week 3)"*.

Both were written before any document but one had been seen. A second real lease
was put through the pipeline on staging, and the two documents do not resemble
each other:

| | first lease | second lease |
|---|---|---|
| pages | 38 | **5** |
| pages with no readable text | 0 detected | **5 of 5** |
| clauses extracted | 221 | **0** |
| twin fields | 5 | **0** |

The second document is a **scan, end to end**. The pipeline behaved correctly:
`minPageChars` found no readable text on any page, so it produced no chunks
rather than chunking noise, and it recorded what it saw —
`page_count 5, image_only_pages [1,2,3,4,5]`. The screen said `0 סעיפים`. Nothing
was invented and nothing was hidden. It is also completely useless, because every
capability after ingestion — retrieval, the twin, the agent, the case history —
reads clauses.

## Decision

**OCR is a required capability of this system, and manual field entry is not an
acceptable fallback for it.** The cut line is withdrawn and the risk register's
mitigation is replaced.

The slice is **not** inserted into day 13 or day 14. It is placed at the week-3
checkpoint (15.1), which is the ritual `PIPELINE.md` §7 already defines for
moving cut-line items, and it is placed with evidence from a spike rather than
with an estimate.

## Why

1. **Scans are not the exception.** One of the two real documents this project
   has seen is entirely a scan. A capability that fails on half the sample is not
   an edge case, and the sample is the only evidence there is.
2. **Manual entry is not a degraded mode, it is a different product.** The lease
   annex obliges Dona Dom to run a 24/7 response centre with a per-apartment
   history of every fault (`docs/reference/lease-template-donadom.md`). A system
   whose documents are read by a person typing fields is an office process with a
   database attached, which is the thing this is meant to replace.
3. **The failure is total rather than partial.** Zero clauses means zero
   retrieval, zero twin, and an agent with nothing to cite. There is no reduced
   answer to give.

## What this decision does *not* settle

**OCR is necessary and it is not sufficient.** The second lease is five pages
where the first is thirty-eight, which almost certainly means it is not the
tender scheme at all — no `נספח א׳`, no annex-keyed commercial terms, and none of
the numbering `internal/clauses.ts` reads. Even with a perfect text layer, clause
detection and the twin's annex-first selection are tuned to a scheme this
document does not follow. That is a second finding and probably a second slice;
this ADR records it so the OCR slice is not mistaken for a complete answer.

## Cost, stated

- **A new processor sees tenant text, and sees more of it than any so far.** OCR
  is handed *whole page images*, including the front page — the names, ID
  numbers, phone numbers and signatures that `twin.ts` deliberately withholds
  from the extraction model by requiring a clause number. `SPEC.md`'s rule is
  that a processor gets a line before it gets a call, and this one is a step
  change rather than another line. If the answer is Google Document AI it is at
  least inside the GCP project already holding the documents, which is an
  argument and not a free pass.
- **Money and latency per document**, on a path that already takes ~11 seconds to
  ingest and ~8 to extract.
- **Accuracy is unknown, and the hard part is not the printed text.** The second
  document carries **handwritten notations and hand-made corrections to the
  printed text**. Three different problems are hiding under one word:

  1. printed Hebrew from a scan — plausible;
  2. handwritten Hebrew in the margins — considerably harder;
  3. **hand corrections to printed clauses** — the dangerous one. OCR that reads
     a struck-out figure and never notices the strike returns the *superseded*
     term, cleanly, with no signal that anything is wrong. That is a wrong answer
     wearing the shape of a right one, which is the failure this system's whole
     citation discipline exists to prevent.

  So the spike's bar is not "is the Hebrew readable". It is **"does the output
  reveal what was changed by hand"** — and if it does not, the honest product
  answer may be to detect handwriting on a page and route that page to a human
  rather than to trust it. Slice 13.2's review screen is the natural home for
  that, which is one more reason not to reorder the two.

## Alternatives considered

- **Manual field entry** — the status quo mitigation. Rejected above.
- **Ask Dona Dom for digital originals.** Worth doing in parallel and cannot be
  relied on: a *signed* contract frequently exists only as a scan of paper, which
  is exactly what this document is.
- **Do it now, before 13.2.** Rejected. Slice 14.2 puts the golden set in CI, and
  everything built after it depends on that regression net; displacing it to
  bring OCR forward by a week costs more than it buys.

## The framing this slice is built under: schema over templates

Recorded here because it is the lens the OCR slice should be scoped through, and
**deferred as a decision** because it cannot honestly be made yet.

The durable thing is **what a tenancy has to know** — term, rent, securities,
notice periods, who pays for what. That is a property of the business. A contract
is only where those answers happen to be written this time, and there will be as
many layouts as there are landlords and lawyers. Building a reader per template
is a treadmill; building the *schema* and letting the model find its fields
wherever they sit is not.

Most of this system already works that way. `internal/twin.ts`'s registry **is**
that schema — five fields, each with a shape and a question, and a sixth costs an
entry and a test rather than a migration. Two things are not:

- **Chunking reads one scheme's numbering** (`1.`, `3.2`, `סעיף 5 –`, annex
  headers). A lease numbered differently chunks worse; one with no numbering
  chunks into nothing useful.
- **Selection asks for `נספח א׳` by letter.** A document with no annex א gets
  *zero clauses sent* — the twin comes back empty not because the model could not
  find the term, but because it was never shown the pages.

The direction is therefore: selection becomes **adaptive** — the cheap annex path
where a document has one, the whole document where it does not — and chunking
**degrades to pages** rather than to nothing. Context windows and per-token
prices both make sending a whole lease unremarkable now.

**What must not move:** the guarantee that a field points at text a human can
check comes from the plumbing, not from the model. The model returns an id; a
citation naming something that was never sent is rejected. That rule is what
makes a wrong answer visible rather than plausible, and it survives.

**What the spike has to settle before this becomes its own ADR:**

1. **Is a page-level citation good enough?** If clause numbering cannot be
   recovered from OCR'd text, a citation degrades from `נספח א׳ §5` to `עמוד 3`.
   Slice 12.1's whole argument was that a citation should name a clause. Whether
   that argument survives the trade is the crux, and it cannot be reasoned out in
   advance of seeing what the text looks like.
2. **Does the whole-document path change what leaves our infrastructure?** Today
   the front page never reaches the model, because selection requires a clause
   number and the front page has none. "Send everything" sends both parties'
   names, ID numbers and phones. OCR already moves this ground by handing over
   whole page images — but it is a decision that deserves its own line in
   `SPEC.md` rather than arriving as a side effect of a better idea.

Its own ADR, after the spike.

## Next

A spike before the slice is scoped: run pages of the second lease through a
candidate OCR path and read what comes back — the printed Hebrew, the margins,
and above all whether a hand-made correction is visible in the output. It answers
the accuracy question, names the processor, and gives the checkpoint a slice with
evidence behind it rather than an estimate.
