# Evidence — Slice 14.1b: guidance docs + the ranking rule

Captured 2026-09-01, day 14's second slice. Measured locally against the mock
lease fixture and the **real** guidance files in `docs/guidance/`,
`text-embedding-3-large@1536`, the model id the config rows name.

**Nothing here is the real lease.** Every clause, figure, name and address below
comes from `evals/fixtures/mock-lease.ts`, which is invented. The policy text is
real, because we wrote it: `docs/guidance/*.md` is in this repo.

## The bar, and how it was met

*"A question with no grounding refuses instead of inventing."*
*Verify: the golden set's refusal cases.*

Met. Two refusal cases in the golden set, both green, both asserting `source:
none` **and** that the refusal handed back nothing to cite. Nine cases pass, up
from five, and the two ranking ratchets went **down to 1**.

---

## 1. The ranking change: the attractor is not down-weighted, it is not indexed

14.1a's finding was that the front page — parties, two ID numbers, a phone, an
email, two addresses — is a universal attractor with `clauseRef: null`. The
decision taken here (Asaf, 2026-09-01) is at **ingest**: a chunk nothing can
cite is stored and never embedded, so its text never reaches the provider at all.

| question | answering clause | 14.1a | 14.1b |
|---|---|---|---|
| `מה גובה דמי השכירות?` | `נספח א׳ §10` | 1st, ratchet 2 | **1st, ratchet 1** |
| `עד מתי חוזה השכירות?` | `נספח א׳ §5` | **2nd**, behind the front page | **1st, ratchet 1** |

The term question is the one that carries the argument: the front page beat the
clause stating the term outright, `0.358` to `0.454`. It is gone from every
result set — **top-3 for 0 of 6 probes, against 3 of 6** — and the clause that
states the term now wins its own question.

Headroom on the new ratchets, since 14.1a set them from jitter rather than from
optimism (re-embedding moves a distance by up to `0.006`):

```
נספח א׳ §10   0.490  ·  next 0.552   lead 0.062
נספח א׳ §5    0.454  ·  next 0.470   lead 0.016
```

The corpus is now reported as two numbers, because they differ:

```
corpus: 19 chunks, 16 indexed · 15 policy sections
```

Three chunks are stored and unsearchable: the front page, and the two annex
headings (`נספח א׳`, `נספח ב׳`) that are a title line and nothing else. The
chunks screen prints both numbers and marks the excluded ones
`לא נכלל בחיפוש`, with their text still fully readable on the page.

**The separation finding survives the fix, and that matters.** Without the front
page the worst answering clause is still `0.652` and the best non-answer `0.470`.
No distance threshold separates them, which is why the refusal below is not one.

## 2. Two defects found while doing it, neither planned

**A phantom annex.** `נספח` followed by one or two Hebrew letters read
`נספח זה מפרט את התנאים…` — *"this annex sets out the terms"*, the way an annex's
own preamble opens — as an annex lettered ז. Every clause after it would have
been cited `נספח זה §…`: **a citation naming an annex that does not exist.** Same
class as the wrapped-sentence phantoms 12.2 fixed, one level up. The marker now
has to carry a geresh or gershayim, or be a single letter standing alone.

Found by writing a test fixture with a realistic annex preamble, not by reading
the code.

**The braid, closed.** Carried since 12.1 and standing in the day-12 evidence:
`נספח א׳ §5` interleaved the label column with the value column. Reproduced from
geometry first —

```
תקופת השכירות הראשונה ומועדי: החל מיום 1 במרץ 2026
תחילתה וסיומה: ועד יום 28 בפברואר 2029
```

— and then closed:

```
תקופת השכירות הראשונה ומועדי תחילתה וסיומה: החל מיום 1 במרץ 2026 ועד יום 28 בפברואר 2029
```

A page with a real corridor between two columns is read column by column and
cell by cell, rather than baseline by baseline. Every other page in the suite is
read exactly as before, and a test pins that a page of prose is not re-read as a
table. **Still to be believed on the real 38-page contract**, which is what the
staging step below is for.

## 3. `catalog`'s first tables: policy through the same pipeline

Three markdown documents we authored — `docs/guidance/*.md` — 15 sections,
loaded by `npm run guidance`:

```
guidance: 3 read · 15 sections · 0 unchanged · text-embedding-3-large
  נוהל דיווח על תקלה   — 5 sections
  נוהל כניסה לדירה     — 5 sections
  נוהל פנייה למשרד     — 5 sections
```

Run again immediately: `3 unchanged`, nothing embedded. Every section is citable
by construction — `heading_ref` is `NOT NULL`, because a file we write has no
cover page — so 14.1b's "an uncitable chunk is never indexed" is satisfied here
by there being nothing uncitable to index.

**No `tenancy_id` anywhere in `0016`.** Policy is org-wide, and a nullable
tenancy column is the exact shape `SPEC-occupancy.md`'s "the filter is a column"
forbids: once it can be null, every query is either blind to policy or is
rewritten as `IS NULL OR = $1`, and the second form is one keystroke from
answering one tenant with another's lease.

## 4. The refusal, designed from numbers rather than from a guess

`npm run measure` grew nine grounding probes, including questions with no answer
anywhere. **8 of 9** land where they should:

| question | wanted | got | cites |
|---|---|---|---|
| `מה גובה דמי השכירות?` | lease | lease | `נספח א׳ §10` |
| `האם מותר להחזיק כלב בדירה?` | lease | lease | `נספח ב׳ §3` |
| `באילו שעות המשרד פתוח?` | policy | policy | `נוהל פנייה למשרד § שעות פעילות המשרד` |
| `כיצד מדווחים על תקלה שאינה דחופה?` | policy | policy | `נוהל דיווח על תקלה § דיווח על תקלה שאינה חירום` |
| `האם צריך לתאם מראש כניסה לדירה לצורך תיקון?` | lease | lease | `§7.4` |
| `באיזו שעה בדיוק יגיע הטכנאי מחר?` | policy | policy | `נוהל כניסה לדירה § תיאום מראש` |
| `כמה עולה מנוי לחדר הכושר במתחם השכן?` | none | **lease** | `נספח ב׳ §5` |
| `מי זכה בגביע המדינה בכדורגל?` | none | none | — |
| `מה מזג האוויר צפוי להיות בסוף השבוע?` | none | none | — |

**The rule is not a cutoff and could not be** (see §1). A passage may ground an
answer when it shares a content term with the question; the lease is preferred
unless the policy uses *strictly more* of the question's own words. That count is
comparable across two corpora in a way a cosine distance is not — it is measured
in the question's words, not in the corpus's.

### The instrument corrected its author twice

Both rows marked `lease`/`policy` above where the probe originally said
`none`/`policy` were **written wrong and fixed by reading the output**, not by
argument:

- `האם צריך לתאם מראש כניסה לדירה לצורך תיקון?` — §7.4 says in as many words
  that the landlord may enter to carry out a repair *after coordinating in
  advance*. The lease does answer this. Lease-first is right.
- `באיזו שעה בדיוק יגיע הטכנאי מחר?` — written as golden 002's refusal, and the
  guidance turns out to answer it: *`נקבע לה חלון זמן ולא שעה מדויקת`*. A
  grounded answer saying a window is set, not an hour, is better than a refusal
  and is what a tenant wants.

This is 14.1a's `§7`/`§7.1–7.3` lesson arriving again: **the corpus decides, the
author of the case does not.**

### Two numbers from tuning it

- **Four characters, not three, for a partial match.** At three, `מדי` — as in
  `מדי חודש בחודשו` — ran into `המדינה`, and *who won the state cup* was grounded
  in the clause stating the rent.
- **Particles are a candidate, never a commitment.** The first cut stripped them
  in a loop, so `שעות` became `עות` and `המשרד` became `שרד`, and every question
  about opening hours matched nothing. A word keeps its own spelling and offers
  the stripped form alongside it.

Both are pinned by tests that name the failure rather than the fix.

## 5. The gate, run whole

```
npm run typecheck    clean
npm run lint         Checked 115 files. No fixes applied.
npm test             tests 494 · pass 494 · fail 0 · skipped 0
REQUIRE_EMBEDDINGS=1 REQUIRE_POSTGRES=1 npm run evals
  corpus: 19 chunks, 16 indexed · 15 policy sections
  ✔ responsibility-cited   ✔ refuses-to-invent      ✔ emergency-escalates
  ✔ rent-ranks             ✔ term-ranks
  ✔ off-lease-refuses      ✔ off-lease-refuses-plainly
  ✔ policy-answers-off-lease   ✔ lease-outranks-policy
  golden set: 9/9 passed, 0 failed, 0 skipped
```

Four new cases, of a **third kind** (`grounding`) added here beside 14.1a's two.
A refusal is not observable in a rank — the question retrieves eight clauses and
none of them answers it — so it needed its own grader. A refusal case may not
name a citation, checked at parse.

## 6. The screen, read rather than described

Rendered from the real route with the real modules, all three outcomes:

```
lease   →  מתוך החוזה של הדירה הזו · 1 קטעים        נספח א׳ §10
policy  →  החוזה אינו עוסק בכך. מתוך נהלי המשרד · 3 קטעים
           נוהל פנייה למשרד § שעות פעילות המשרד · 0.350
refuse  →  אין לכך מענה בחוזה או בנהלים. השאלה מועברת למשרד.
```

and the chunk list, saying how much of itself a search can reach:

```
כל הסעיפים במסמך · 19 (16 ניתנים לחיפוש)
ללא מספור · עמוד 1 · לא נכלל בחיפוש
```

with the front page's text still printed in full underneath it — stored, and not
searchable, which is the whole distinction.

## Gaps, stated

- **Not measured on the real lease yet.** Every number here is the 8-page
  fixture's. The 38-page contract had these two questions at 5th and 3rd of 8,
  and removing one attractor is not obviously enough there. **The staging
  re-ingest is what settles it**, and until it is run this slice is proven on a
  document that ranks cleaner than the real one.
- **A question about a neighbouring building is grounded in our own gym clause.**
  `כמה עולה מנוי לחדר הכושר במתחם השכן?` shares three real words with
  `נספח ב׳ §5`, and a term-overlap signal cannot see *which building*. Not
  contorted around: it wants the ~30 cases at 14.2 and week 4's prompt.
- **The rule misses a plural formed by a suffix.** `דירות` is `דירה` with the ה
  replaced, which a common-prefix test cannot span. Normalizing `ות`→`ה` was
  considered and rejected on measurement: it makes `שעה` match `שעות המנוחה`, and
  the technician question then grounds in the lease's quiet-hours rule.
- **A withdrawn policy file is not deleted.** `syncGuidance` replaces what it
  finds and leaves alone what the source no longer offers.
- **The `model` column records the configured model, not the embedder that
  produced the vector.** A contract test using the fake embedder writes rows a
  search cannot tell from real ones. Harmless in CI, where the database dies with
  the job; locally it is residue, and `npm run reset` now clears it.
- **`npm run guidance` is a human step.** Nothing checks that an environment's
  guidance matches the repo, so a deployed staging can silently be a version
  behind `docs/guidance/`.

## Commands

```
npm run measure     the instrument — result sets, attractors, separation, grounding
npm run evals       the gate — ranks against the ratchets, and the refusals
npm run guidance    load docs/guidance/*.md into the catalog
```
