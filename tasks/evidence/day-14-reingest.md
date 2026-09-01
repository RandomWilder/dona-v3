# Evidence — Slice 14.1c: let a lease that has fields be read again

Captured 2026-09-01, day 14's third slice. Two halves: the contract test locally,
and the **real** 38-page lease on staging, revision serving `d36b242`.

**No contract text is reproduced here.** `tasks/fuses.md` records that the repo
has never held a real contract, and this file does not change that: the one
defect below that needed a shape to be legible is drawn as a schematic with the
contract's own words and figures removed. Everything quoted verbatim is a
column name, a count, or a Postgres error.

## The bar, and how it was met

*"A document that has been extracted can be ingested again, and its reviews
survive."*
*Verify: the new contract test, plus a re-ingest of the real lease on staging.*

**Met, both halves.**

---

## 1. The defect, reproduced before it was fixed

The contract test was written first and failed first — which is the whole reason
it was worth writing, since the failure is the slice:

```
✖ lets a document that has been read into fields be read again
  error: update or delete on table "occupancy_document_chunks" violates
         foreign key constraint "occupancy_lease_facts_chunk_id_fkey"
  code: '23503'
  detail: Key (id)=(01a0a44b-…) is still referenced from table
          "occupancy_lease_facts".
  at replaceChunks (src/occupancy/internal/documents.ts:972)
```

`replaceChunks` deletes a document's chunks; `occupancy_lease_facts.chunk_id` is
`ON DELETE RESTRICT` (`0013`). Note the shape of the failure as much as its
existence: a raw driver error, not the kernel's, so the operator got an opaque
500 rather than anything nameable.

`0013`'s own comment had described the missing behaviour since the day it was
written — *"re-ingesting a document deletes its chunks, which is why extraction
is replaced with them rather than left pointing at text that has moved."* The
intent was written down and never implemented. It has been true since 13.1.

## 2. The gate, local

Run whole, not tailed:

```
npm run typecheck                      clean
npm run lint                           Checked 115 files. No fixes applied.
REQUIRE_POSTGRES=1 npm test            tests 495 · pass 495 · fail 0 · skipped 0
REQUIRE_EMBEDDINGS=1 npm run evals     9/9 passed, 0 failed, 0 skipped
```

CI on [#36](https://github.com/RandomWilder/dona-v3/pull/36): `gate` pass 35s,
`evals` pass 32s. Merged as `d36b242`.

## 3. The staging half — and a false start worth keeping

The first attempt did not test anything, for two independent reasons, and both
were only visible in the logs:

```
08:44:46  boot  d68770f   ← pre-14.1c revision still serving
08:45:16  POST  /extract  302  6.3s
08:46:02  GET   /chunks?q=…  200
08:46:30  boot  d36b242   ← 14.1c arrives AFTER both presses
```

The press was `/extract` and not `/ingest`, and it landed on the old revision.
**Two buttons carry nearly the same Hebrew label** — `קריאה מחדש` on the unit
page is the clause re-read (`views.ts:224`), `קריאה מחדש של השדות` on the
document page is the field re-read (`views.ts:461`) — and `extractTwin` deletes
only facts, which was always permitted, so it succeeded and proved nothing.
Worth a note in `SPEC-staff.md`: the two most consequential buttons on the
admin differ by two words.

The real press, on `d36b242`:

```
10:31:30  POST /ingest    302   8.9s   ← the press that returned 500 an hour earlier
10:31:53  POST /extract   302   9.7s
10:33:02  GET  /chunks?q=…  200  0.8s
```

Zero 5xx and zero `severity>=ERROR` across the whole window.

## 4. Read back out of the database, not off the screen

13.2's standard, and the right one here: the screen that writes a result is not
evidence that it wrote it. Read-only over the runbook's Cloud SQL proxy, session
pinned `default_transaction_read_only = on`:

```
document    : 01a0391c-…            1,695,258 bytes
ingested_at : 2026-09-01T10:31:37.469Z
pages       : 38

chunks      : 212        (was 221 before the re-read)
indexed     : 211        stored-not-indexed: 1
facts       : 4          citing a missing chunk: 0
reviews     : 5          standing: 0
```

**The three numbers that are the slice:** the re-ingest landed on a document
that had facts, **five reviews survived it**, and **no fact is left citing a
chunk that no longer exists**. The reviews have no foreign key to either the
fact or the chunk — 13.2 built them that way on purpose — so they came through
untouched, which is the mechanism working rather than an omission.

The one stored-not-indexed chunk is the cover page (`ordinal 0 · p1 ·
clause_ref null`), so 14.1b's privacy rule fired on the real contract and not
only on the fixture.

---

## 5. Four findings, none of them a 14.1c failure

**Recorded here because this press produced them, and carried to the slices
that own them.**

### 5.1 `נספח א׳ §5` is still braided — 14.1b's fix does not hold on the real lease

14.1b's commit states the two-column layout closed: *"the label's sentence cut
in half with a value pushed through it… now read column by column and cell by
cell."* On the real `נספח א׳` it is still interleaved. The shape, with the
contract's words replaced by their roles:

```
[label part 1] [body line 1] [label part 2] [body line 2] [label part 3] [body line 3]
```

The row's label is cut into **three** pieces with body lines pushed between
them, in one 453-character chunk correctly numbered `נספח א' §5` on page 14. The
citation is right and the text inside it is scrambled — which is the worse
half, because the clause looks citable.

**This is the finding the week turns on.** 14.1b's numbers are the 8-page
fixture's, where the fix works; the real contract's `נספח א׳` has a layout the
fixture does not reproduce. The two-column pass needs its own measurement
against the real geometry, and that is a slice rather than a patch.

### 5.2 `notice` did not come back at all

Facts went 5 → 4: `deductibles`, `rent`, `securities`, `term` returned, `notice`
produced nothing. Day 13 measured `notice` swinging between `§5.3` and
`§5.4–5.5`; a field vanishing entirely is a new point on that curve. **14.2's**,
with the extract-twice-and-diff case.

### 5.3 Standing is 0 of 5, where the plan expected 5

The todo's step 6 expected the five reviews to come back standing after a
re-extract. They did not. **The honest reading is that two causes are tangled
here and one press cannot separate them:** the extractor oscillates (5.2), *and*
the chunking genuinely changed underneath (221 → 212 chunks, plus 5.1's braid),
so the clause text fed to the extractor is not the text that produced the
values a human confirmed on 2026-08-31. Narrowing `stands` on this observation
would be PIPELINE.md §9's named anti-pattern; the eval in 14.2 is what settles
it.

### 5.4 `image_only_pages` is `[]` on a 38-page scan

The carry from day 12 — *"the four image-only pages are not detected, and the
screen says otherwise"* — confirmed still true rather than newly broken. Waits
on the OCR spike at 15.1.

---

## 6. Open, and not chased in this slice

**3 of the 211 indexed chunks contain a 9-digit run.** That is the shape of an
Israeli ת״ז — and equally the shape of a ח.פ. company number, which belongs in a
commercial lease's clauses legitimately. `SPEC-occupancy.md` and #36 state the
privacy guarantee absolutely (*"never reach the provider at all"*), so which of
the two it is decides whether that sentence is true as written. Counted, not
read: they are a real contract's text. **Resolve before the sentence is relied
on.**

## 7. What is owed after this

14.1b's staging verification is still **not** complete. Steps 2 and 4 are
answered above (the chunk count moved; the braid is still there). Outstanding:
the two ranks written down, `npm run guidance` over the tunnel, and the three
grounding outcomes read.
