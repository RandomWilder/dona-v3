# Evidence — Slice 14.1a: the ranking instrument

Captured 2026-09-01, day 14's first slice. Measured locally against the mock
lease fixture, `text-embedding-3-large@1536`, the model id the config rows name.

**Nothing here is the real lease.** Every clause, figure, name and address below
comes from `evals/fixtures/mock-lease.ts`, which is invented — see "What the
fixture is" for why the instrument is built on an authored document rather than
on the signed contract.

## The bar, and how it was met

*"The instrument reproduces 12.2's measured ranks on the fixture — or reports,
with numbers, that it does not."*

**It does not reproduce the ranks, and it does reproduce the cause.** That
distinction is the finding of the slice, and it is stated first because it
changes what 14.1b should do.

## What the fixture is

An eight-page Hebrew lease authored as `PdfPage[]` — the shape the kernel's PDF
adapter outputs — fed through the real `chunkLease`, the real embedder, real
pgvector and the real `searchClauses`. Only pdfjs is bypassed, because Hebrew
through pdfjs needs an embedded font and a CMap, and this defect is about
semantic similarity rather than character decoding.

It cut into **19 chunks**: the front page as one 859-character chunk with
`clauseRef: null`, nine body clauses, `נספח א׳ §5 / §10 / §12`, and `נספח ב׳`'s
five house rules.

## 1. Do the two golden questions rank as they did on the real lease? No.

| question | answering clause | real lease (12.2) | mock fixture |
|---|---|---|---|
| `מה גובה דמי השכירות?` | `נספח א׳ §10` | 5th of 8 | **1st of 8** |
| `עד מתי חוזה השכירות?` | `נספח א׳ §5` | 3rd of 8, dist `0.428` | **2nd of 8**, dist `0.454` |

The fixture ranks **better** than the real document. It is 8 pages against 38 and
19 chunks against 221, and its topics are cleanly separated in a way a real
contract's are not — so an answering clause has far less to compete with.

**What this means for the ratchets:** they are honest numbers for *this* corpus
and they are not the real lease's numbers. The gate they provide is "retrieval on
a clean document does not get worse", which is a real regression gate and a
weaker one than 14.1b needs. Named here rather than glossed.

## 2. Is the front page a universal attractor? Yes — the hypothesis holds.

The front page — parties, two ID numbers, a phone, an email, two addresses, a
parcel number, a tender number — is in the **top 3 for 3 of 6** probes, on
questions with nothing to do with any of it.

The two golden questions are where it shows most sharply:

| question | answering clause | front page | gap |
|---|---|---|---|
| `מה גובה דמי השכירות?` | `0.490` | `0.498` | **+0.008** |
| `עד מתי חוזה השכירות?` | `0.454` | **`0.358`** | **−0.096** |
| `האם מותר להחזיק כלב בדירה?` | `0.543` | `0.632` | +0.089 |

On the term question the front page **wins outright**, beating the clause that
actually states the term by a clear margin. On the rent question it comes second
by `0.008` — closer than the run-to-run jitter of the embedding itself is
comfortable with.

So 12.2's hypothesis is confirmed on an independent document: *a long
heterogeneous chunk sits close to everything.* It reproduced at 19 chunks, which
means it is a property of the chunk rather than of the corpus size.

**And it is the privacy finding too.** The chunk that wins a question about the
lease term is the one carrying both parties' names and ID numbers, and it carries
no clause reference, so nothing downstream can cite it — it can only be fed to a
model. That is 14.1b's decision to take deliberately.

## 3. Does distance separate right from wrong? No.

| | |
|---|---|
| all distances observed | `0.177` – `0.744` |
| worst answering clause | `0.652` (`§7.1–7.3`, the repairs question) |
| best non-answer | `0.358` (the front page, on the term question) |

The two overlap, and not marginally: the best wrong answer scores **0.294 better**
than the worst right answer.

**There is no single distance threshold that admits every right answer and
rejects every wrong one.** A refusal rule of the form *"refuse when nothing
scores below T"* cannot be built on this signal — which is the reason 14.1 was
split before any code was written, and the number 14.1b's refusal design has to
start from.

## 4. Ranks are stable; distances are not

Three consecutive runs, each re-embedding the fixture from scratch:

```
ranks       identical across all runs
distances   max |Δ| = 0.0060 · mean |Δ| = 0.00102   (48 paired distances)
```

This is why the case files assert **rank and never distance**, and it is not a
guess any more. It also set the ratchets: `נספח א׳ §10` measures at rank 1 but is
ratcheted to **2**, because its `0.008` lead over the front page is inside the
`0.006` jitter and a ratchet of 1 would be a coin flip in CI. 14.1b still has to
reach rank 1 to prove a fix.

## 5. The gate, proven in both directions

```
npm run evals            5/5 passed, 0 failed, 0 skipped        exit 0
  corpus: 19 chunks indexed
```

Tightening `term-ranks` to `rankAtMost: 1` on purpose:

```
  ✘ term-ranks
      נספח א׳ §5 ranked 2, worse than the ratchet at 1
golden set: 4/5 passed, 1 failed, 0 skipped               exit 1
```

And the two ways it can lie, both closed:

```
npm run evals            (no key)  3/5 passed, 0 failed, 2 skipped   exit 0
REQUIRE_EMBEDDINGS=1     (no key)  fails loudly                      exit 1
```

## 6. A grader detail worth keeping

The repairs probe first named its clause `§7` and came back
*"did not come back at all in 8 hits"* rather than *"ranked badly"*. Clause 7's
sub-clauses are short, so `chunkLease` merges them and spells the reference
`§7.1–7.3`. **A clause reference in a case is decided by the chunker, not by the
author of the case** — and the grader distinguishing "absent" from "badly placed"
is what made that legible in one run instead of a debugging session.

## Gaps, stated

- **The ratchets are the mock lease's, not the real lease's.** A ranking change
  that fixes the fixture is not thereby proven on the 38-page contract. 14.1b
  should re-measure on staging before believing itself.
- **Six probes is not a distribution.** Enough to confirm an attractor and to
  disprove a threshold; not enough to tune a ranking function against. 14.2's ~30
  cases are where that arrives.
- **The behavioural cases are still graded by a placeholder subject.** There is no
  agent yet (week 4), so `refuses` and `citesClause` are asserted against
  `evals/subject.ts`'s stub. The retrieval half is real; that half is not.
- **The corpus leaves residue.** Each run indexes a fresh tenancy into the local
  database, as the contract tests do. `npm run reset` clears it; CI's database
  dies with the job.

## Commands

```
npm run measure   the instrument — every result set, attractors, separation
npm run evals     the gate — ranks against the ratchets
```
