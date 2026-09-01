# SPEC: channel

Conventions inherited from SPEC.md. The module above the others: it is where two corpora are put
in order, and where a question is allowed to have no answer.

- **Responsibility:** The agent (widget, later WhatsApp), tenant verification, tone — and, since
  slice 14.1b, **what a question may be answered from**
- **Depends on:** all modules, through their `contract.ts` only
- **Commands:** `groundQuestion`
- **Events:** none yet
- **Success criteria:** an off-lease question returns "unknown + escalate", never an invention

## Grounding: this tenancy's lease → company policy → refuse (slice 14.1b)

`occupancy.searchClauses` searches one tenancy's clauses and stops. `catalog.searchGuidance`
searches org-wide policy and stops. **Ordering them is neither module's business**, and SPEC.md's
map puts this module above both — so the rule lives here, and week 4's agent reaches for it as a
tool rather than calling the two searches itself. That is what stops the ordering rule from being
re-decided inside a prompt.

### `groundQuestion({ tenancyId, question }) → Grounding`

```
{ source: 'lease' | 'policy' | 'none', hits: GroundedHit[], escalate: boolean }
```

A hit carries what a citation needs: `ref` (`נספח א׳ §10`, or
`נוהל פנייה למשרד § שעות פעילות המשרד`), the heading, the text, the distance, and the page range
where there is one. Policy has no pages.

`escalate` is true exactly when `source` is `none`. It is named rather than left for a caller to
infer from an empty list: *"no hits"* and *"hand this to a person"* are the same fact here, and a
caller that reads only one of them is a caller that answers anyway. The golden set asserts the two
agree.

### The order is by source, and the tie-break is by the question's own words

Two corpora embedded by one model still produce distances that are **not comparable across them**:
a policy written in plain Hebrew out-scores a clause written in contract Hebrew on a plainly-worded
question, every time, without being the better answer. So nothing here compares a lease distance to
a policy distance.

What is comparable is **how much of the question each corpus actually uses** — a count of the
question's own content words, in the question's own units. The lease wins ties, so a tenant's own
contract outranks a company procedure unless the procedure answers *strictly more* of what was
asked. Measured on the real files: `באילו שעות המשרד פתוח?` finds one word in the lease's
quiet-hours rule (`נספח ב׳ §1`) and three in `נוהל פנייה למשרד § שעות פעילות המשרד`.

### The refusal is not a distance cutoff, and could not be

Slice 14.1a measured that out of the running before this slice was written: the worst answering
clause scored `0.652` and the best non-answer `0.358`, an overlap of `0.294`. Removing the
front-page attractor (14.1b) narrowed it and did not close it. **A refusal of the form "refuse when
nothing scores below T" is not buildable on this signal.**

What replaced it is `internal/terms.ts`: a passage may ground an answer when it shares at least one
content term with the question, after Hebrew's single-letter particles are allowed for. Pure, its
own tests, and stated plainly as a heuristic.

**When it is wrong, it refuses.** Hebrew morphology is richer than the affix handling in that file —
`דירות` is `דירה` with the ה replaced, which a common-prefix test cannot span — so a question and
the clause that answers it can share a root and not a token, and the answer will be a refusal. That
is the direction the error is deliberately allowed to fall: **a refusal sends a tenant to a human,
and an invention sends them away satisfied and wrong.**

Two numbers from tuning it, both kept because they are the kind of thing that gets re-argued:

- **Four characters, not three, for a partial match.** At three, `מדי` — as in `מדי חודש בחודשו` —
  ran into `המדינה`, and a question about who won the state cup was grounded in the clause stating
  the rent.
- **Particles are stripped as a candidate, never as a commitment.** The first cut stripped in a
  loop, so `שעות` became `עות` and `המשרד` became `שרד`. A word keeps its own spelling and *offers*
  the stripped form alongside it.

### A refusal hands back nothing at all

Not a shortened list — an empty one. A caller given the near-misses would put them in a prompt, and
a model handed eight irrelevant clauses and asked to be helpful invents the ninth. The golden set
asserts this separately from the source, because it is the failure that would survive a correct
`source: 'none'`.

### What is deliberately not here

- **An answer.** `groundQuestion` returns passages, not prose. The agent that turns them into a
  Hebrew sentence with a citation is week 4, and SPEC.md rule 2 keeps it a client of this command.
- **Verification.** `tenancyId` arrives resolved. Today the only caller is the admin screen, where
  it is resolved server-side from the unit an operator opened; week 4's tenant path resolves it from
  a verified possession proof, and the fail-closed rule in SPEC.md applies there.
- **Ranking the two corpora into one list.** They are ordered, not merged. A tenant asking about
  their own flat should be told which of the two answered.

## Presentation surface (slice 5.1)

`GET /t/:link` serves `ui/index.html` — the tenant widget shell. Registered through `contract.ts`
(`registerChannelUi`).

**Mobile first, genuinely.** This is the screen a tenant opens on a phone from a link in an SMS.
The layout is a full-height column: a chrome bar, a thread that scrolls, a composer pinned to the
bottom (`100dvh`, so the mobile URL bar cannot cover it). Above 760px it becomes a centred card —
the phone case is the default, not the fallback.

**The composer is dead on purpose.** Textarea and send button are `disabled` and say so in
Hebrew. A composer that accepts text and drops it teaches a tenant the system is broken; a
disabled one is honest. It wakes up in week 4 with the agent loop.

**`:link` is ignored, and that is deliberate.** Signed links, OTP step-up and session expiry are
week 4 (ROADMAP). Today the route serves a static shell and **never echoes the parameter into
the HTML** — no reflection, no XSS surface, nothing personal to disclose because the page holds
no data at all. When verification lands, the fail-closed rule from SPEC.md applies here first:
no personal data before server-side possession proof.

**Tone.** Hebrew, `dir="rtl"`, no English chrome. Ids, phone numbers and timestamps get
`dir="ltr"` isolation when they arrive.
