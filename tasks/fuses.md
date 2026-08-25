# External fuses log (Slice 1.1)

> One note per fuse: date fired, current status, who owes what next. Check the morning status of each per the carry rules in `todo.md`.

## 1. Meta WhatsApp Business verification
- Fired: 2026-08-21 (or earlier)
- Status: **in progress** — verification underway
- Who owes what: Meta owes approval; Asaf checks status weekly.

## 2. SMS provider (Twilio)
- Fired: 2026-08-21 · **Closed: 2026-08-22 ✅**
- Status: **DONE — test OTP round trip approved.** Account upgraded (Full), funded ($20), Verify service "Dona Ops" (SID `VA4d9ade…`), Israel enabled in geo permissions. OTP sent via Verify API to Asaf's Israeli number, delivered within seconds, VerificationCheck returned `approved` (2026-08-22 06:21 UTC). Israeli deliverability confirmed.
- Findings (2026-08-22):
  - **Post-upgrade quirk:** Verify kept returning error 21608 ("trial account") for 15+ min after the account read `type: Full` via the API. Workaround that closed it: registered the phone as a Verified Caller ID via the `OutgoingCallerIds` API using the **voice-call** channel (console caller-ID verification by SMS is geo-blocked for Israel). If this recurs with another number, same workaround applies.
  - Credentials live in `~/.twilio-dona.env` (chmod 600, outside repo) locally; production keys go to Secret Manager (week 4).
- Findings (2026-08-21):
  - **No console "try it out" page** — Verify has no manual test-send UI; testing is via the Verify REST API (curl/Postman/SDK). Logs at Console → Monitor → Logs / Verify service Logs.
  - **Hebrew missing from Verify's default message locales** (console preview jumps Greek→Hindi). Tenant-facing OTP copy would be English by default. Mitigations to evaluate at week 4, behind the `sms` adapter: Twilio Verify custom templates (requires Twilio approval), or InforU/019 fallback with our own copy. Not a week-1 blocker.
  - Israeli deliverability: signup OTP reached Asaf's Israeli number via Twilio — positive signal; own-service test will confirm.
  - Branded alphanumeric sender ID in Israel needs domestic pre-registration (~1 week) — only needed later for branded sends, not for OTP.

## 3. Data request to Dona Dom  — **NO LONGER A DEV BLOCKER (2026-08-25)**

> **Reframed by Asaf, 2026-08-25, and this is the important line in this file.**
> **Development runs on mock data we define. Real tenant data enters only at phase-1
> sign-off, after the system has proved itself.** We do not wait for Dona Dom's format and
> then bend to it — we design the format for optimal system coverage, build against it, and
> the data request we eventually send them is *derived from our own templates*.
>
> This inverts the dependency that had been holding day 8 open since 2026-08-22. Nothing in
> weeks 3–5 is blocked on this fuse any more. What remains is a **deliverable owed towards
> sign-off**, not an input owed to us now:
>
> - `docs/reference/tenant-table-template.csv` — the tenant/unit/phone format, as a
>   filled-in example rather than a description
> - `docs/reference/tenant-table-format.md` — the column rules and what the importer does
>   with a bad file
>
> Both grow as the system does. At sign-off they become the request.
>
> **Still true, and the one piece of real data in the system:** a real signed lease arrived
> 2026-08-24 and sits in both document buckets. See "The real lease" below.

### The real lease — a stated exception with a deadline

Asaf's call on 2026-08-25, taken against the recommendation to mock it, and recorded with the
risk rather than quietly: **the real signed lease stays for week 3's ingestion work only**,
because it is messy in ways a lease we write ourselves would not be, and extraction tested
against our own assumptions is not tested.

What that costs, stated: it is a real contract with real names, ID numbers and signature
images, living in an environment with **no alerting, no PITR, no retention rule and no
deletion path** (all week 6). It is the sole reason staging is not a freely breakable
environment.

**Removal is owed at phase-1 sign-off** — from `gs://dona-v3-staging-docs` and
`gs://dona-v3-prod-docs` both. This line exists so it cannot drift past that.

**And from Postgres, as of slice 12.1.** The contract is no longer only in the buckets: the
`occupancy_documents` row indexes it, and `occupancy_document_chunks` now holds **its clause
text**, extracted from the PDF and stored verbatim. Deleting the objects would leave the lease
readable in the database. The removal owed at sign-off is therefore three things, and a
deletion path (week 6) has to know about all three:

```
gs://dona-v3-staging-docs   the object
gs://dona-v3-prod-docs      the object
occupancy_documents         + occupancy_document_chunks   the row and the clause text
```

### Original request (history)
- Fired: 2026-08-22 ✅
- Status: **sent and acknowledged** — Dona Dom confirmed a set of all relevant documents will be sent, organized **by apartment**, phone numbers included.
- Who owes what: Dona Dom owes the document set; on receipt, Asaf + Claude map which document is needed at which stage of residency (feeds the week-2 importer and week-3 ingestion design).
- **2026-08-24:** still not received, two days on. Slice 8.1's importer was built anyway, against a seeded fixture, per `ROADMAP.md:175`'s contingency — so the table now has somewhere to land the day it arrives. What is still owed is unchanged, and 8.1 cannot be closed without it: five spot-checks against the source document are its third acceptance bar. **Next check: 2026-08-25.** If it slips further, the mapping table alone (not the lease PDFs) is the piece that unblocks day 8 — worth asking for it separately rather than waiting for the whole set.
- Requested: lease PDFs · tenant↔unit↔phone table · vendor list · deductible rules · fault Q&A doc

## 4. GCP + OpenAI + domain
- Fired: 2026-08-21
- Status: **partial**
- Done: GCP project created (`dona-v3`, project number 149055978002) ✓ · billing linked & enabled (acct `017AD7-9B4A59-12DDB4`) ✓ · monthly budget ₪500 with 50/90/100% + forecast alerts, verified via API 2026-08-22 ✓ · OpenAI paid API key ✓
- Done also: OpenAI budget confirmed 2026-08-22 — fresh key, prepaid balance > $20 (hard spend ceiling; sufficient for now) ✓
- Outstanding: domain for `app.` / `admin.` ☐ — **deferred, owed by Dona Dom** (they will provide the domain later; not a blocker).
- **Updated 2026-08-23 after slice 4.1:** the earlier note said the domain was needed "by 4.x/5.x at the latest" — that turned out to be wrong. Staging deployed fine on the Cloud Run URL `https://dona-staging-ydabrrmura-zf.a.run.app`, and prod (4.2) will too. The domain is only needed to map custom hostnames, so it does not gate week 1 at all.
- Who owes what: Dona Dom owes the domain; Asaf raises it with them before custom-domain mapping.
- Note: budget display name says "dona-v1 — monthly" but targets the correct project (cosmetic). Billing Budget API enabled on dona-v3 for verification.
