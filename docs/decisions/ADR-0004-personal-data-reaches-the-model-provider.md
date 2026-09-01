# ADR-0004 — Personal data reaches the model provider, and that is a decision rather than an accident

- **Date:** 2026-09-01
- **Status:** proposed — the technical mitigation is decided, the legal basis is owed
- **Context slice:** measured during 14.1c's staging verification, before 14.2

## Context

`SPEC-occupancy.md` claimed, in two places, that the parties' names and ID
numbers never reach the model provider. Slice 14.1b's front-page rule was read
as making that true. **Measured on the real contract on 2026-09-01, it is not.**

Excluding the cover page removes the PII-densest *single chunk*. It does not
remove the *category*, because the same parties reappear inside numbered annex
clauses, which are indexed, embedded and therefore sent:

```
נספח ו׳ §1   p21-22   name · home address · 9-digit ID · mobile
נספח ו׳ §2   p21      two names · full ת״ז each
נספח י״ב     p37      company number · two names + ת״ז · address · mobile · email

19 of 211 indexed chunks mention ת״ז or תעודת זהות
```

Every one of the 211 indexed chunks was embedded by
`text-embedding-3-large@1536`. Extraction is narrower — it selects by clause
reference — but the annexes that carry the identifiers *have* references, so the
narrowing is not a guarantee either.

**The owner's question, and it is the right one:**

> as long as we are storing the information securely in postgres, and using the
> Open AI api key on a closed system, and not exposing ids to tenants other then
> their own — can you explain to me what the issue is? is that really a problem?
> is there any other way of doing this?

## The answer, separated into the three things it bundles

### (a) The documentation defect is real and is not arguable

This repo's premise is that **the spec is the prompt** (PIPELINE.md §2). A spec
asserting an absolute privacy property that does not hold is worse than a spec
that says nothing: every later reader — human or agent — designs on it. That
half is a straightforward correction and is already made.

### (b) Sending the data is probably lawful, and is *not* self-evidently fine

Sending contract text to a processor is ordinary. The relevant points, stated
plainly:

- The **API** is not the consumer product. Business API data is not used for
  training by default, and a DPA and zero-retention options exist. This is a
  processor relationship, not publication.
- What makes it lawful is therefore **contractual and disclosed**, not
  technical: a data processing agreement with the provider, and data subjects
  who were told their contract is processed by a third party.
- Israeli law treats a national identifier as high-sensitivity, and the 2024
  amendment to the Privacy Protection Law tightened obligations materially.
  **Cross-border transfer has its own rules.** Whether ours are met is a
  question for counsel, not for this file — and the honest status is that
  nobody has asked.
- "A closed system" is the part that does not survive contact: the key is
  scoped, but the *data* leaves our infrastructure and lands with a US provider.
  Access control on our side is not a transfer basis.

So: not an emergency, not a breach, and **not nothing**. The exposure is real,
the likely remedy is paperwork, and the risk of assuming it is fine is that a
tenant's national ID sits in a third party's logs with no agreement naming it.

### (c) Yes, there is another way — several, and one is cheap

| option | cost | what it buys |
|---|---|---|
| **Redact identifiers before embedding/extraction** | low | the text stays whole in Postgres; only a masked copy is sent. Nobody searches a lease by ID number, so retrieval loses nothing |
| Exclude the identity-bearing annexes, as the cover page is excluded | low | crude — loses genuinely citable clauses (`נספח ו׳` is the security instrument) |
| Zero-retention / DPA with the provider | low, not ours to build | removes the retention half, not the transfer |
| Regional or self-hosted embedding | high | residency, at a large quality and operations cost |

**Redaction at the boundary is the recommendation.** It is a pure function over
chunk text, it belongs beside `isRetrievable` in `clauses.ts` where the rest of
"what a lease is" lives, and it is testable without a provider. It also
composes with the existing rule instead of replacing it.

## Decision

1. **The false claim is withdrawn from `SPEC-occupancy.md`** — done, both
   places, with the measurement that disproved it.
2. **Redaction before the provider boundary becomes a slice**, not a patch: an
   identifier-shaped run is masked in the copy sent to the embedder and the
   extractor, and never in the copy stored. It needs its own golden cases —
   masking must not change which clause answers a question.
3. **The legal basis is owed and is the owner's to obtain**, not the agent's to
   assert: a DPA with the provider, and disclosure to data subjects. Recorded
   on `tasks/fuses.md` beside the real lease's removal deadline, because they
   have the same trigger — phase-1 sign-off, when real tenants replace our
   mock data.
4. **Nothing is rolled back today.** The data already sent cannot be unsent, the
   corpus is one contract belonging to a party who is not a pilot tenant, and
   stopping ingestion would block week 4 for a risk that paperwork closes.

## Consequences

- The privacy argument for not indexing the cover page is **narrowed to what
  was measured**: it removes one dense chunk, and it improves ranking. The
  ranking argument was always the load-bearing one and is untouched.
- Week 4 puts a tenant on the other end of a model call. **Redaction should land
  before that**, because a tenant's own question plus their own lease is a
  larger surface than one contract in a staging bucket.
- `tasks/fuses.md` gains a second obligation with the same deadline as the
  lease's removal.
