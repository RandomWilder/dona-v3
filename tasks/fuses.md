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

## 3. Data request to Dona Dom
- Fired: 2026-08-22 ✅
- Status: **sent and acknowledged** — Dona Dom confirmed a set of all relevant documents will be sent, organized **by apartment**, phone numbers included.
- Who owes what: Dona Dom owes the document set; on receipt, Asaf + Claude map which document is needed at which stage of residency (feeds the week-2 importer and week-3 ingestion design).
- Requested: lease PDFs · tenant↔unit↔phone table · vendor list · deductible rules · fault Q&A doc

## 4. GCP + OpenAI + domain
- Fired: 2026-08-21
- Status: **partial**
- Done: GCP project created (`dona-v3`, project number 149055978002) ✓ · billing linked & enabled (acct `017AD7-9B4A59-12DDB4`) ✓ · monthly budget ₪500 with 50/90/100% + forecast alerts, verified via API 2026-08-22 ✓ · OpenAI paid API key ✓
- Outstanding: OpenAI budget cap confirmed ☐ · domain picked for `app.` / `admin.` ☐
- Who owes what: Asaf confirms the OpenAI cap and picks the domain.
- Note: budget display name says "dona-v1 — monthly" but targets the correct project (cosmetic). Billing Budget API enabled on dona-v3 for verification.
