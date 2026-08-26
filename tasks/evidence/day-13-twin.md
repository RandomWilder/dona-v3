# Evidence — Slice 13.1: extraction to structured fields (the digital twin)

Captured 2026-08-26, day 13's first slice. Staging serves `1370e89`.

**No content of the real lease is reproduced here, and no amounts.** Clause
references, page numbers, counts and latencies only — the rule
`day-12-chunking.md` and `day-12-embeddings.md` were written under, and it
matters more here than it did there: the fields this slice extracts *are* the
contract's commercial terms. Where a figure had to be checked, this file records
that it was checked and against which clause, never what it says.

## The bar, and how it was met

*"One real lease's fields are extracted with a clause reference on each."*
*Verify: read the extracted fields against the document.*

Read on staging by the owner, in a browser, against the PDF — as every slice
since 11.1 has been. Five fields were attempted and five came back, each citing
a clause and a page that a human turned to:

| field | citation | page |
|---|---|---|
| תקופת השכירות | `נספח א׳ §5` | 14 |
| דמי השכירות | `נספח א׳ §10` | 14–15 |
| בטוחות | `§12.1.1`, rows citing `נספח א׳ §12` | 7 |
| הודעה מוקדמת | `§5.3`, `§5.4–5.5` | 3–4 |
| חיובים והשתתפות | `נספח י״א §3`, rows citing `נספח י״א §1.1.8–1.1.9`, `§2.1.1–2.1.4`, `§2.2.1.4–2.2.1.6`, `§3.6–3.8` | 27 |

### The two that carry the argument

**The term came out whole.** An initial period, then two options, then a cap —
three date ranges and a limit, matching the clause quoted beside them, and the
arithmetic of the annex's own three sub-totals adds to the cap. `SPEC-occupancy.md`
says storing one end date would state a falsehood the moment an option is
exercised; the stored value has nowhere to put one, and the screen shows why it
would have been wrong.

**The rent is the rent, and not the maintenance fee.** This is the failure
`docs/reference/lease-template-donadom.md` names for this annex: `נספח א׳ §10`
states both figures, one on page 14 and one on page 15, and a lease read badly
answers "what is the rent" with the maintenance charge. The owner checked the
extracted base figure against page 14 and confirmed it is the rent. The
maintenance figure was not extracted into the rent field, and neither number
appears in this file.

The stored shape is base figure, index, base month and the re-basing rule in the
lease's own words. **No figure in the system was computed from another** — SPEC.md
rule 7, enforced by a shape with nowhere to put one.

### Per-row citations, on the real document

`הודעה מוקדמת` and `חיובים והשתתפות` came back as lists whose rows cite
*different* clauses — three notice windows across `§5.3` and `§5.4–5.5`, and the
who-pays split across four separate `נספח י״א` clauses. A list citing one clause
for all its rows would have been a false citation for every row but one, which
is why the rows carry their own.

## What only staging could prove

- **The model call works end to end**, with a key the repo has never held. The
  boot line: `extraction: openai`; the screen names the model that read it.
- **The clause selection is good enough to answer from.** Every field was
  answered out of clauses chosen deterministically by clause reference and
  keyword — no similarity search was involved, and the front page (which carries
  no clause number, and carries both parties' identifying details) was never
  sent to the provider.

## What the first press cost, and what it taught

The slice did not work on its first deploy, and the failure is the more useful
half of this file.

| press | revision | result |
|---|---|---|
| 09:59 | `ffa238f` | **504 at 300.000s** — Cloud Run's request timeout |
| 10:58 | `1370e89` | 302 in **189.4s** |
| 10:59 | `1370e89` | 302 in **8.3s** |

The first press produced a blank page after five minutes: five model calls,
issued in sequence, each at the provider's **default reasoning effort**, because
`reasoning_effort` was not being sent at all. Nothing was written — a pass
replaces facts only after every call returns — so the failure was correct and
useless.

`#28` fixed three things, in ascending order of how much they mattered: a
per-call `AbortSignal.timeout` so a slow call becomes a sentence naming the
field rather than a blank page; concurrent calls, so the request costs the
slowest one rather than their sum; and `reasoning_effort` as a config row,
seeded `none`. Migration `0014` moved the model from a value chosen by argument
to `gpt-5.6-luna`, chosen from this measurement.

**189s then 8.3s is not yet explained.** No single call exceeded the 60s bound —
one that had would have thrown — so five concurrent calls summing to ~190s means
they were serialized somewhere outside this system, most likely provider-side
queueing. The 8.3s repeat is consistent with prompt caching and warm limits.
Pressing again after the cache window would distinguish the two, and week 4 puts
a tenant on the other end of a model call, so it is worth knowing before then.

## What is not good enough yet

- **The securities read one obligation as two.** The annex offers a cash deposit
  *or* a bank guarantee — one requirement in either form — and the twin lists
  both, each carrying the same stated amount. A reader adding them would see
  twice the security the lease requires. It is the review screen's case exactly
  (13.2), and a golden case for 14.2; it is recorded rather than patched into
  the prompt, because a prompt tweak with no eval is PIPELINE.md §9's named
  anti-pattern.
- **`חיובים והשתתפות` names the payer, not the subject.** The registry asks for
  what the charge is about; the model returned who bears it. Useful either way,
  and vocabulary week 5's `catalog` has to settle rather than inherit.
- **Every field is unreviewed.** An extraction is a claim until a human confirms
  it, and nothing can confirm or correct one until 13.2. The screen says so.
- **A chain of model calls still sits on a browser request.** Bounded and
  concurrent is not the same as belonging there; that wants `kernel/work.ts`,
  the slice auto-ingest is already waiting for.

## Merged

[#27](https://github.com/RandomWilder/dona-v3/pull/27) — the twin, the port, the
migration, the screen. [#28](https://github.com/RandomWilder/dona-v3/pull/28) —
the timeout, the concurrency, the measured model. Staging serves `1370e89`;
`/health` returns it.
