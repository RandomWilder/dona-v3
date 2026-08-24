# Reference — the Dona Dom lease template

Derived from one signed lease supplied by Dona Dom on 2026-08-24, read in full (38 pages).

**Scrubbed deliberately.** No names, ID numbers, phone numbers, email addresses, bank
details or per-tenancy amounts appear here. This note describes the *template and its
rules*, which is what later weeks need; the tenancy itself lives only in the private
document store (`docs/runbook-deploy.md` → "Private document store"). Keep it that way
when this note is updated.

> One document is one sample. The building it describes may not be in the pilot. What is
> likely to generalise is the **structure**, because the scheme is tender-mandated: the
> same annex layout should recur across Dona Dom's stock. Treat specific values as
> unconfirmed until a second lease agrees with them.

## What kind of agreement this is

A **דיור להשכרה** long-term rental under a state tender, overseen by משרד הבינוי והשיכון
and רשות מקרקעי ישראל — not an ordinary private lease. Consequences that matter to us:

- Rent is capped and formula-driven rather than negotiated (below).
- Tenant **eligibility** (זכאות) is part of the relationship, and some units in the scheme
  are reduced-rent (דירה במחיר מופחת) with their own rules.
- The contract explicitly contemplates the landlord passing tenant data to **third parties
  providing IT services** and to the ministry for oversight. That is the consent basis the
  system we are building operates under — worth knowing, and worth not exceeding.
- חוק הגנת הדייר is explicitly disapplied.

## Document anatomy

The body is boilerplate; **the facts live in the annexes.** Anything that reads a lease
must go to נספח א׳ first and must not scrape the front page.

| part | holds | ingestion note |
|---|---|---|
| body, ~13 pages | 20 clauses of legal boilerplate | policy text, few facts |
| **נספח א׳** | **unit, term, rent, maintenance fee, securities** | **the digital twin's source** |
| נספח ב׳ | תקנון המתחם — house rules, quiet hours, grills, pets | tenant-guidance content |
| נספח ג׳ | direct-debit mandate | partially filled; bank details |
| נספח ד׳ / ה׳ | ID copies, guarantee | **placeholders — "sent separately by email"** |
| נספח ו׳ | שטר חוב | introduces the guarantor |
| נספח ז׳ | plans + מפרט טכני | floor plan is an image; the spec lists fixtures |
| נספח ח׳ | פרוטוקול מסירת חזקה | **blank in the sample** — meter readings, move-in defects |
| נספח י׳ / י״א | maintenance booklet + **מפרט תחזוקה** | SLA tiers and who-pays |
| נספח י״ב | late-delivery addendum | compensation formula |

**A complete lease is not one file.** Two annexes say their content was emailed separately,
and the handover protocol was unfilled. Ingestion should expect an incomplete document and
say so, rather than treating absence as "no guarantee exists".

## Format (measured, not assumed)

- **34 of 38 pages carry a clean Hebrew text layer.** Extraction preserves logical order,
  numbers and bidi marks. **Hebrew OCR is not needed for the prose** — this was the single
  largest unknown in the week-3 plan.
- Four pages are image-only: the placeholder page, the floor plan (CAD), a spec cover, and
  one page of comparison tables. Only the tables carry rules we would want.
- **Every fact is typed.** Handwriting appears only as signatures, initialled per page.
- The real difficulty is **layout, not character recognition**: נספח א׳ is a two-column
  label/value table, and naive extraction interleaves labels with the values above them.
  Clause-aware chunking is required for a correct answer, not merely a tidier one.
- In the sample, the landlord's signature block was blank on all three signature pages
  while the tenants had initialled throughout. Which copy is authoritative is a question
  for Dona Dom, and matters for a product that answers by citing clauses.

## Response times — contractual, not product choices

The maintenance annex fixes these. `catalog` (week 5) must adopt this vocabulary rather
than invent one; changing a tier is a contractual question, not a config change.

| tier | response from notification |
|---|---|
| בהול — safety-critical | **2 hours** |
| דחוף | **4 hours** |
| דחיפות בינונית | **24 hours** |
| רגילה | reasonable, **no later than 30 days** |

**Escalation is written in:** a fault at a lower tier moves up if the condition worsens
while waiting. That is a state machine, not a static classification, and `case` needs to
model it.

Worked examples are given per tier — burst main, gas leak, person trapped in a lift, whole-
apartment power loss, main sewage blockage — and are the natural seed for the golden set.

## Who pays

- **Landlord / management company:** fair wear and tear, building fabric and systems,
  common property, periodic preventive maintenance on a fixed schedule (lifts monthly,
  water tanks annually, fire detection twice yearly, and so on down a long list).
- **Tenant:** damage from unreasonable use, damage caused by their own installations,
  cleaning A/C filters at least twice a year, replacing burnt bulbs, blockages they caused,
  pest control inside the unit, painting on exit.
- **The hinge clause:** a defect inside the unit caused by unreasonable tenant use is not
  the landlord's. A defect in *common* property caused by unreasonable tenant use becomes
  the tenant's only if not remedied within 14 days of written notice.

Deductible rules in `catalog` should start from this split.

## The obligation that describes this product

The annex requires the landlord to operate **a telephone response centre, every day, at all
hours (24/7)**, and further requires that:

- every fault and maintenance action is **documented**, including root cause and the
  preventive measures taken to stop recurrence;
- a **per-apartment history** of faults and works can be produced on demand;
- periodic reports of work performed go to the developer.

The system being built is a contractual obligation of Dona Dom's, not a convenience. The
audit log therefore has a downstream consumer — a per-apartment report — which is worth
knowing before its shape is fixed.

## Structures that models must accommodate

- **Term is not a single date.** An initial term plus two options, capped at ten years
  overall, with notice windows before each rollover. Storing one end date will state a
  falsehood the moment an option is exercised.
- **Rent is a formula.** A base figure linked to the consumer price index against a named
  base month, re-based annually, plus a professional re-assessment every three years, with
  per-m² floor rates by room count fixed in the body. Store base + index + rule, never a
  single number. (Money stays read-only — SPEC.md rule 7.)
- **Parties are three kinds, not two:** landlord; tenants, jointly and severally; and a
  **guarantor** who signs the שטר חוב, has his own contact details, and does not live
  there. He is a party to the tenancy, not an occupant — which is why the role belongs on
  the occupancy link rather than on the person (`SPEC-occupancy.md`).
- **Two tenants, two mobile numbers, no mapping.** The sample never says which number
  belongs to which tenant. An importer must be able to record "unconfirmed" rather than
  guess. Guessing wrong inside a household is recoverable; guessing wrong across households
  is the isolation failure SPEC.md forbids.
- **Parking and storage are numbered and reassignable** — the landlord may move a tenant's
  bay temporarily or permanently (EV charger installation is named as a reason). They
  belong to the tenancy, not permanently to the unit.
- **The unit's start date is in the annex, not the header.** In the sample the "signed on"
  line was never filled; the authoritative dates are the annex term and the defects-period
  start.

## Identifiers disagree with themselves

Within this one document the same apartment appears under **three different plot numbers**
across the body, the floor plan and the technical spec, and the building carries one number
in the annex and another on the plan. Block and parcel are consistent; מגרש is not.

This is why `portfolio`'s key normalisation is deliberately naive
(`SPEC-portfolio.md`): a rule clever enough to reconcile these would be clever enough to
**merge two genuinely different buildings**. Reconciliation is the importer's job, done
deliberately against a mapping, not a normalisation side effect.

## Assets named in the technical spec

Useful when `catalog` replaces `portfolio`'s fixed asset-kind list with data rows. In the
unit: solar water heater on a shared collector system, mini-central air conditioning, smoke
detector, intercom handset, electric shutters (app-controlled over wifi), safe-room filter,
fire extinguisher, and individual gas, water and electricity meters. In the building: two
lifts with Shabbat mode, generator, fire detection and suppression, electric gates, water
pumps and tanks.

`portfolio`'s nine kinds cover the common cases; safe-room filter, electric shutter, smoke
detector and extinguisher are not among them, which is the expected outcome of a fixed list
meeting real stock.

## Open questions for Dona Dom

1. Is there a **countersigned** copy? The landlord's signature block was blank.
2. The **emailed annexes** — ID copies and the deposit confirmation — are part of the
   agreement but not the file. How should they reach the system?
3. Is the **handover protocol** filled in elsewhere? It holds meter readings and move-in
   defects: the baseline for every later "was this broken when I moved in?" dispute.
