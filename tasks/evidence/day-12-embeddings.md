# Evidence — Slice 12.2: embeddings → pgvector, scoped by occupancy

Captured 2026-08-26, day 12's second slice. Staging serves `f2834a9`.

**No content of the real lease is reproduced here**, and no distances are quoted
beside text that would identify a party. Clause references, counts and scores
only — the same rule `day-12-chunking.md` was written under.

## The bar, and how it was met

*"A question retrieves clauses from one lease and provably cannot reach
another's."* Both halves hold.

**Retrieval works.** Asked in Hebrew on staging, through the admin search field,
against the real lease's 221 clauses:

| question | the clause that answers it | rank |
|---|---|---|
| מה גובה דמי השכירות? | `נספח א׳ §10` — rent and maintenance fee | 5th of 8 |
| עד מתי חוזה השכירות? | `נספח א׳ §5` — the full term structure | 3rd of 8 |

Both are returned, both cite a clause, both name a page a human can turn to.
Neither ranks first — see "What is not good enough yet".

**Isolation is proven by a test that attempts the crossing**, not by asserting a
filter exists. Two tenancies hold near-identical leases; each asks for the
other's *exact* clause text — the strongest possible pull, since the
deterministic test embedder scores an exact string at distance 0 — and each
receives only its own rows. Asserted in both directions, because a filter can be
right one way and absent the other. A tenancy id that is not yours returns an
empty list rather than `not_found`: a distinct error would confirm the tenancy
exists, which is an isolation leak wearing an error code.

At the edge, a URL pairing this document with a different unit returns `404`
rather than searching one tenancy under another's heading.

## What only staging could prove

- **The key resolves and the model answers.** The boot line is the evidence:

```
dona-v3 f2834a9 … docs: gs://dona-v3-staging-docs · embeddings: openai:text-embedding-3-large@1536
```

  The revision before it carried no `embeddings:` segment at all. Secret,
  IAM grant and config rows all worked first time.

- **Cost of the guarantee, measured.** Ingest went from `2.9s` to `10.9s` —
  about eight seconds to embed 221 clauses in three batches. No warnings, no
  errors, status 302. Well inside Cloud Run's request timeout, and the reason
  auto-ingest on upload stays deferred to durable work.

## Three defects the lease found, and a fourth it did not

Slice 12.1 closed with 273 chunks. Reading real search results found three
things our own fixtures had agreed with, all fixed in
[#25](https://github.com/RandomWilder/dona-v3/pull/25) — the count is now **221**.

1. **Two phantom clauses.** `§18` was invented out of *"…יחולו הוראות סעיף /
   18 להלן."* and `נספח י״ב §43` out of the parcel numbers *"חלקה / 43 ו-46"* —
   a sentence wrapping onto a line that starts with a digit. One of them cited a
   land-registry entry as a contractual term. `§2.5` now reads whole.
2. **Headings ranked as answers.** `§6` — *"6. מטרת השכירות וייחודה"* and nothing
   else — came **seventh for a question about rent**, on a shared word and no
   content. A bare parent heading now folds into the clause it heads.
3. **The screen misreported its own results.** Eight hits above the full clause
   list, in identical cards, read as "about 150 results". Both lists are now
   labelled.

The fourth was found and deliberately not fixed: see below.

## What is not good enough yet

**Removing 52 junk chunks did not move the ranking**, and the numbers say so
plainly. The date question, before and after:

| rank | before (273 chunks) | after (221 chunks) |
|---|---|---|
| 1 | front page `0.360` | front page `0.360` |
| 2 | an annex cover `0.388` | an annex cover `0.422` |
| 3 | **`נספח א׳ §5` `0.428`** | **`נספח א׳ §5` `0.428`** |

Identical. The cleanup improved what a citation *says*; it did not touch what
outranks the answer.

**The diagnosis, which is worth more than the symptom.** Both winning chunks are
the same kind of thing: a long, heterogeneous front page — parties, dates,
addresses, parcel numbers, boilerplate. A chunk like that embeds near the centre
of the vector space and therefore sits close to everything; the same chunk won
two questions on unrelated topics. That is a chunk-shape problem wearing a
ranking problem's clothes, and every distance in both result sets fell between
`0.35` and `0.51` — relevant and irrelevant alike, which is what "not
discriminating" looks like from outside.

**A privacy consequence, not only an accuracy one.** That front page is the
PII-densest chunk in the document — two names, two ID numbers, two phone
numbers, an email — and it is currently the most likely text to be retrieved for
any vague question. Week 4's agent feeds top hits into a prompt, so those hits
reach the model. That should be decided in 14.1 deliberately, not inherited.

**Why it was not fixed today.** There is no instrument to measure a fix against.
Changing retrieval on the evidence of two questions and a hunch is exactly
PIPELINE.md §9's *"prompt-tweaking without evals — you fix one case and silently
break five."* Slice 14.1 builds the ~30 Hebrew golden cases that make the
question answerable; these two questions are its first two cases, and the
diagnosis above is its starting hypothesis.

**Day 13 is not blocked by any of it.** The digital twin reads `נספח א׳ §5` and
`§10` **by clause reference** through `listChunks`, not by similarity. Both hold
their full content: §5 carries the initial period, both options and the ten-year
cap; §10 carries the rent, the maintenance fee and the index-linkage rule.

## Also standing, and known

- **`נספח א׳`'s two-column layout is only half solved.** `§5`'s text interleaves
  the label column with the value column — the dates survive and are readable,
  but the sentence is braided. 13.1 reads this clause.
- **A running footer is still swallowed** into the clause spanning it.
- **Prod has no key** (`tasks/fuses.md` fuse 4). A `v0.3.0` tag today would
  deploy a prod revision whose embedder refuses — loudly, on the boot line, by
  design. One command closes it.
