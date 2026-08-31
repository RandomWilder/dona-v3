# Evidence — Slice 13.2: the admin review screen

Captured 2026-08-31, day 13's second slice. Staging serves `39473f5`.

**No content of the real lease is reproduced here, and no amounts.** Field
names, clause references, page numbers, row counts, key names and timestamps
only — the rule `day-13-twin.md` was written under, and it applies with more
force here: this slice's rows hold the contract's commercial terms twice over,
once as the model read them and once as a person left them.

## The bar, and how it was met

*"One real lease's fields are reviewed and confirmed on staging."*
*Verify: the confirmed record, read back.*

Reviewed on staging by the owner, in a browser, against the PDF. Read back out
of the database rather than off the screen that wrote it:

```
facts=5  reviews=5  standing=5
```

| field | decision | citation | what the human changed |
|---|---|---|---|
| תקופת השכירות | confirmed | `נספח א׳ §5` p14 | — |
| דמי השכירות | **corrected** | `נספח א׳ §10` p14–15 | `baseAmount` |
| בטוחות | **corrected** | `נספח א׳ §12` p15 | `items`, 3 rows → 2 |
| הודעה מוקדמת | confirmed | `§5.3` p3 | — |
| חיובים והשתתפות | confirmed | `נספח י״א §3.6–3.8` p36–37 | — |

Every review names `asaf@dona.co.il` and the minute it was made. Nine
`occupancy.reviewLeaseField` rows are in `audit_log`, all `ok`, each carrying
`{documentId, field, decision}` and **no value** — the rule 12.1 wrote, holding
on real data, and the reason `tasks/fuses.md` counts five places and not six.

## The correction the slice was built for, made

`בטוחות` was day 13's carried finding: the annex offers a cash deposit **or** a
bank guarantee, and the twin read it as two obligations with one stated figure
each, so a reader adding them saw twice the security the lease requires. The
reviewer dropped a row:

```
extracted: פיקדון · ערבות בנקאית · שטר חוב      (all citing נספח א׳ §12)
kept:                ערבות בנקאית · שטר חוב
```

Both surviving rows still carry their own citation, re-derived from the chunk
rather than taken from the form. The finding is closed on the real lease, by a
person, through the control built for it — and it is worth recording that it was
**confirmed as correct first, at 12:12, and corrected thirty minutes later**.
A review screen can manufacture the error it exists to catch; what stops that is
a reviewer reading the document, not the screen.

`דמי השכירות` is the second correction: one key, `baseAmount`. `currency`,
`indexBaseMonth` and the re-basing rule came through untouched and the citation
held. This is the failure `docs/reference/lease-template-donadom.md` names for
`נספח א׳ §10`, arriving again — and now answerable in the product rather than
only in a note. **It is the first golden case 14.2 should carry.**

## The rule the slice existed to honour, exercised in anger

13.1 required that a re-extraction producing a different value must not leave
the old confirmation standing beside the new number. It was proven by test
before merge. Staging then proved it by accident, which is better.

Four extraction passes ran over the same document today: `11:54`, `12:02`,
`12:34`, `12:57`. One press of *קריאה מחדש של השדות* at `12:34` moved four of
the five fields at once:

| field | what moved between `12:02` and `12:34` |
|---|---|
| term | `options`, `statedText` |
| rent | `rule` only — the base figure did not move |
| securities | nothing |
| notice | `items`, 2 rows → 3, **and its citation**, `§5.3` p3 → `§5.4–5.5` p3–4 |
| deductibles | `items`, 7 rows → 11 |

Four reviews went `stands=false` in one press and `בטוחות` stood, because its
value came back byte-identical. The count on the screen read `1/5`, and nothing
had been approved — which is exactly the design: the office does not re-confirm
five fields because someone pressed a button.

**Then the `12:57` pass moved three of them back.** `rent`'s correction, made at
`12:10` against the `12:02` extraction, stands again at `12:57` without anyone
touching it — as do `notice`'s confirmation from `12:12` and `בטוחות`'s
correction from `12:42`. `reviewed_value` did the thing it was put in the schema
to do: it carried a human's statement across two re-reads and reattached it when
the ground came back, with no history to reconcile and nothing to re-approve.

## The measurement that matters more than the slice

**The extractor oscillates.** Same document, same model, the same
deterministically-selected clauses, `extraction.reasoning_effort` = `none`
(migration `0014`) — and the answer went **A → B → A** across three passes. Not
a drift in one direction: a swing between at least two answers, in row counts
(`deductibles` 7 → 11 → 7), in prose, and in **which clause a field is read
from** (`notice`, `§5.3` ↔ `§5.4–5.5`).

That is a stronger finding than "the twin was wrong once", and it is cheap to
turn into a gate: an eval that extracts twice and diffs would have caught it.
Carried to 14.1/14.2 with these numbers rather than as an impression. It is also
the reason the `stands` comparison was **not** narrowed when the `rent` case
made it tempting — a drift in prose the reviewer never touched invalidated their
correction of a figure, and changing a comparison rule on one observation with
no eval run is the anti-pattern PIPELINE.md §9 names.

## What the screen was missing, found by using it

The argument for keeping a superseded review rather than deleting it is that it
is the only record the field ever said something else. The screen named the
reviewer and the day and withheld the value, so the corrected figure was
readable in Postgres and nowhere on the page — the argument was true of the
table and false of the product. Fixed in
[#32](https://github.com/RandomWilder/dona-v3/pull/32): the superseded value
sits under a closed `<details>`, with `תוקן` and `אושר` named apart. Verified on
staging on the live superseded rows, not on a fixture.

## What this does not settle

- **`חיובים והשתתפות` still names the payer where the registry asks for the
  subject**, and it is now *confirmed* that way. The reviewer read it against the
  document and accepted the rows; the mismatch is in the vocabulary rather than
  in the reading, and it stays week 5's `catalog` to settle. Worth naming
  plainly: a confirmed field can carry a known modelling mismatch, and a green
  tick on this screen means "a person read this against the contract", never
  "the schema was the right shape for it".
- **A review has no history.** One row per field, the later decision replacing
  the earlier — so confirming a field that was previously corrected discards the
  record of the correction, and `audit_log` cannot supply it because it
  deliberately holds no values. Nothing depends on that record today, and the
  honest place to want one is the slice that has to explain a value to a tenant.

## Merged

[#31](https://github.com/RandomWilder/dona-v3/pull/31) and
[#32](https://github.com/RandomWilder/dona-v3/pull/32). Gate green on both:
typecheck, lint, 448 tests with `REQUIRE_POSTGRES=1` and none skipped, golden
set 3/3. Staging serves `39473f5`.
