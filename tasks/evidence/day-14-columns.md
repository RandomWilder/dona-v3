# Evidence — Slice 14.1d: the real annex's corridor is 11 points

Captured 2026-09-01, day 14's fourth slice. The measurement came first and the
rule came out of it, which is 14.1a's order applied to geometry instead of to
ranking.

**No contract text is reproduced here, and none was printed while measuring.**
Every number below is a coordinate, a count, a character length or a hash. The
one place the shape of a clause had to be legible, it is drawn as a letter
sequence with the words removed. The instruments live in the session scratchpad
and read the PDF that is already in the staging bucket; the repo still holds no
real contract (`tasks/fuses.md`).

## The bar, and how it was met

*"`נספח א׳ §5` reads as one whole sentence on the real contract."*
*Verify: the chunk's text read back from staging's database.*

**Met locally and measured; the staging half is the press that follows the
merge** (§6).

---

## 1. What was wrong, measured before anything was changed

14.1b found a column corridor **by its width** — at least `columnGapOf`, which
is 35.7pt on an A4 page. On the real `נספח א׳` the corridor is **11.0pt**, so
`splitColumns` returned null, the page was read line by line, and `נספח א׳ §5`
came out braided inside a citation that was correct.

And the obvious repair was dead before it was tried, on the same page's numbers:

```
page 14: 139 text runs, 34 baselines
widest corridor accepted by 14.1b's test : 11.0 pt
columnGapOf(595.32) demands              : 35.7 pt
intra-line word gaps  p50 3.0 · p90 12.2 · p95 15.9
gaps >= 11.0 pt : 17 of 100     <- the corridor is inside the word-gap distribution
```

## 2. The signal that does work, and the one that does not

**Vertical persistence was the hypothesis, and on its own it is wrong.** Counting
the rows that *cross* a candidate corridor finds the real one on page 14 — and it
also finds one on six pages of ordinary prose:

```
crossing-free candidates across all 38 pages, with what stands on each side:

page    x  corridor | left span/chars | right span/chars
   2  497     19.9  |     387 / 2413  |       8 /    4
   3  497     19.9  |     387 / 2649  |       8 /    4
   5  492     14.6  |     387 / 2976  |      14 /    5
   8  492     14.6  |     387 / 2935  |      14 /    6
  12  492     14.6  |     387 / 2959  |      14 /    6
  16  492     14.6  |     387 / 2805  |      14 /   30
  14  362     10.8  |     261 / 1073  |     109 /  165   <- נספח א׳
  15  362     10.8  |     256 /  543  |     109 /  144   <- נספח א׳
  32  390     79.9  |      24 /    4  |     116 /   61
```

Every body page has a corridor that is wider than the annex's, holds all the way
down the page, and has not one row crossing it. It is the margin the clause
numbers sit in — a column 8–14pt wide holding 4–30 characters.

**So the rule asks what a column is, not how far away it is:** almost no row
crosses it (at most two — the annex's own title and its closing paragraph), and
each side is at least a tenth of the page wide and carries at least 60
characters. Nothing measured lands between 30 and 101.

**The floor is 60 and not 65 because of one page.** A body page carries a margin
65pt wide holding 45 characters. Read as a table it merged nine sub-clauses into
a single chunk cited by their parent (`§12 (1/2)`, `§12 (2/2)` in place of
`§12.1.1 … §12.3`) — the same defect this slice exists to remove, arriving from
the other direction. It was caught by running the whole contract through both
chunkers, not by reasoning.

## 3. The braid, before and after, without quoting the clause

The defect is alternation: walking the produced chunk from start to end, how
often does the text stop coming from one column and start coming from the other?
`L` is a line of the label column, `V` a line of the value column.

```
נספח א׳ §5    before  LVLVLVVVVVVV   5 alternations · 10 lines · 453 chars
              after   LLLVVVVVVVVV   1 alternation  ·  2 lines · 456 chars

נספח א׳ §3.2  before  LVLL           2 alternations
              after   LLLV           1 alternation

נספח א׳ §10   before  LLVLLVLV       5 alternations
              after   LLLLVLVV       3 alternations
```

`§5` is the bar and it is met: the label's three pieces are contiguous and its
values follow them. **`§10` improves and is not clean** — three alternations
remain, and it is the rent clause, so it is carried rather than claimed.

## 4. What it changed on the whole contract, page by page

Both versions of `chunkLease` were run over the same 38-page PDF and compared as
`(citation, pages, length, sha256)` — never as text:

```
chunks: before 212 · after 221
page-groups identical : 41
page-groups changed   : 27
```

The 27 are **two** things, and only the first was planned:

- **pages 14, 15 and the clauses spanning into 16, 18–20, 26–27** — the annex,
  now read as a table. This is the slice.
- **pages 27 through 36** — every clause's citation changes from `נספח ט׳` to
  `נספח י״א`. This is §5 below.

## 5. The finding: ten pages have been cited under the wrong annex since 14.1b

Page 27 carries three annex headings and a 65pt stub column beside them. 14.1b's
width test read it as a table on a 39.6pt corridor, which merged the headings
into the page's text — so `נספח י׳` and `נספח י״א` stopped existing, and every
clause after them inherited `נספח ט׳`.

Run over the same PDF, three versions of the chunker:

```
page | pre-14.1b  | today (14.1b) | after (14.1d)
  27 | ט׳, י׳, י״א | ט׳            | ט׳, י׳, י״א
  28 | י״א        | ט׳            | י״א
  …  |            |               |
  36 | י״א        | ט׳            | י״א

chunks: pre-14.1b 221 · 14.1b 212 · 14.1d 221
```

**It is live on staging.** 14.1c's re-ingest on 2026-09-01 wrote those 212 chunks,
so the contract's maintenance annex is currently searchable under the wrong
letter — and day 13's twin, extracted before 14.1b, cited `נספח י״א` clauses that
a re-extraction today would name `נספח ט׳`. The re-ingest in §6 is what removes
it.

Two things worth keeping about how it was found: it was **not** the defect being
chased, and it was invisible to every test in the repo, because no fixture had a
page shaped like that one. A test now does.

## 6. The gate

Run whole, output written to a file first and the counts read out of the file:

```
npm run typecheck                      clean
npm run lint                           Checked 115 files. No fixes applied.
REQUIRE_POSTGRES=1 npm test            tests 498 · pass 498 · fail 0 · skipped 0
REQUIRE_EMBEDDINGS=1 npm run evals     9/9 passed, 0 failed, 0 skipped
```

Three of those 498 are new: the narrow corridor read as a table, a numbering
margin refused as a column, and a page with one stub column refused as a table —
the last built to page 27's shape.

**The golden set's fixture now carries the real geometry.** `evals/fixtures/mock-lease.ts`
laid `נספח א׳` out as full-width lines, and the chunker's own unit test used a
40pt corridor — which is why 14.1b passed everything here and failed on the
contract. The annex is now a two-column table with an 11pt corridor whose cells
wrap onto different baselines, and it reproduces the braid on the old code:

```
before:  'תקופות הארכה, מימושן' / [value line] / 'וההודעה עליהן'      <- the label, cut in half
after :  'תקופות הארכה, מימושן וההודעה עליהן: שתי אופציות בנות …'
```

Both ranking cases still rank **1** with the annex in its new geometry
(`נספח א׳ §10` at 0.490, `נספח א׳ §5` at 0.466), so the ratchets hold through the
change rather than being moved to accommodate it.

## 7. What is owed after this

- **The staging press**, which is this slice's stated Verify: re-ingest the real
  lease and read `נספח א׳ §5` back out of the database. Expect the chunk count to
  go 212 → 221 and the `נספח ט׳` citations on pages 27–36 to become `נספח י״א`.
- **14.1b's staging verification**, still outstanding and now unblocked: the two
  ranks written down, `npm run guidance` over the tunnel, the three grounding
  outcomes read.
- **`נספח א׳ §10` is still partly braided** (3 alternations, §3). It is the rent
  clause, so it belongs in 14.2's cases rather than in a patch here.
