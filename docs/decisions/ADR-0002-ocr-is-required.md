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
- **Accuracy is unknown.** Hebrew OCR on a scan of this quality may or may not
  produce text that chunks into clauses at all. Nobody knows yet, and a slice
  scoped before knowing would be an estimate wearing a plan.

## Alternatives considered

- **Manual field entry** — the status quo mitigation. Rejected above.
- **Ask Dona Dom for digital originals.** Worth doing in parallel and cannot be
  relied on: a *signed* contract frequently exists only as a scan of paper, which
  is exactly what this document is.
- **Do it now, before 13.2.** Rejected. Slice 14.2 puts the golden set in CI, and
  everything built after it depends on that regression net; displacing it to
  bring OCR forward by a week costs more than it buys.

## Next

A spike before the slice is scoped: run pages of the second lease through a
candidate OCR path and read the Hebrew that comes back. It answers the accuracy
question, names the processor, and gives 15.1 a slice with evidence behind it.
