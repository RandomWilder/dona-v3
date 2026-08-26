# SPEC: Dona Dom Tenancy OS (shared conventions)

Living document. Every module spec (`SPEC-<module>.md`) inherits these conventions and does not repeat them. Governing docs: `ROADMAP.md` (what, when) · `PIPELINE.md` (how) · `docs/` (SRS + Product Vision).

## Objective

An operations system of record for Dona Dom's residential rentals, with an AI agent as its tenant-facing client. Routine tenancy events complete autonomously; the office supervises exceptions. North star: zero-touch resolution rate.

## Foundation rules (invariants — cut features, never these)

1. **Modular monolith, one deployable.** Modules are bounded contexts with contracts; a module exposes commands + events, and nothing imports another module's internals — only its `contract.ts`.
2. **The agent is a client, not a brain.** It acts solely through documented module commands (tool-calling); every call is audited. Model, prompt, and channel changes never touch business logic.
3. **Channel is an adapter.** Web widget first; WhatsApp drops in behind the same interface; voice someday — same seam.
4. **Policies are data.** Deductibles, who-pays, SLA thresholds, offer timeouts, quiet hours, emergency definitions, kill switches: config rows editable in admin, never constants.
5. **One error shape; idempotency on business intent.** Machine code + human message + optional details. Keys come from intent (job id, offer id), stored in the kernel; a retried command returns the first result. Durable timers/outbox live on Postgres.
6. **One presentation system.** Shared `tokens.css` + self-contained HTML per screen; Hebrew RTL, logical properties; no bundler.
7. **Money is read-only — permanently.** Read financial context, record consents, draft documents. Never bill, charge, or move money.
8. **Specs gate code.** Update the module spec before the code; contract tests + the golden set run in CI and block merges.

## Module map

| Module | Responsibility | Depends on |
|---|---|---|
| kernel | Ids, clock, error shape, migrations, idempotency, audit, outbox, durable work. No business logic. | — |
| identity | People, phones, roles (tenant, vendor, staff). | — |
| portfolio | Buildings, units, assets, access notes. | — |
| occupancy | Current lease: who lives where, who is billed; lease documents (indexed per occupancy). | identity, portfolio |
| catalog | Job types, rates, who-pays/deductible rules, self-service how-tos, policy text. | — |
| vendor-roster | Approved vendors, trades, matching rules. | identity |
| case | One tenant matter: intake, classification, photos, diagnosis, status, thread, priority. | occupancy |
| job | Priced work spawned from a case; assigned only on accept. | case, catalog |
| dispatch | Offers to matching vendors; first valid accept wins; timeout → exception. | job, vendor-roster |
| fulfillment | Visit, evidence, tenant sign-off, close; no-show handling. | dispatch |
| channel | The agent (widget, later WhatsApp) + tenant verification. Tools only; owns tone. | all above |
| staff | Admin panel edge: auth, roles, queue, conversations, approvals, settings. Not a domain module. | all above |
| import | CSV load of the tenant mapping table. A tool, not a domain module: no tables, no invariants. | identity, portfolio, occupancy |

No cycles. Contracts live in the provider module's spec.

## Error shape (all modules)

One shape everywhere: `{ code, message, details? }`. Codes: `not_found` · `not_allowed` · `conflict` · `invalid` · `unavailable`. Never return null for an error; never leak internals.

## Testing strategy

- Contract tests per module using only public commands.
- Race tests for dispatch (two accepts ⇒ one winner); timeout tests (no accept ⇒ exception); restart tests for durable work.
- Golden set (`evals/`): real-style Hebrew tenant cases asserting grounding, clause citation, refusal to invent, isolation, escalation. Runs in CI, gates merges, grows from production failures.
- No mocked business data outside automated tests.

## Security defaults

- Fail-closed verification: no personal data before server-side possession proof (verified sender / OTP to number-on-record).
- Absolute tenant isolation enforced at the query layer (every read scoped by verified occupancy) — proven by tests that attempt to cross it.
- PII never in logs; parameterized queries; validate all inputs at the edge; rate-limit public endpoints.
- **Third parties that see tenant text are named here, not discovered later.** As of slice 12.2 lease clause text is sent to OpenAI to be embedded — a real contract's contents leaving our infrastructure. The consent basis is in the lease itself, which contemplates the landlord passing tenant data to third parties providing IT services (`docs/reference/lease-template-donadom.md`), and the same note's warning applies: worth knowing, and worth not exceeding. Any further processor gets a line here before it gets a call.
- **The same processor, a second kind of call (slice 13.1).** Selected clause text now also goes to OpenAI *with a prompt*, to be read into structured fields rather than into vectors. No new company sees tenant text, and the consent basis is the one above — but a completion is a different act from an embedding, so it gets its line. What is sent is decided deterministically and is narrower than what is stored: only chunks that carry a clause number, which excludes the document's front page and therefore the names, ID numbers, phones and email printed on it.

## Status

Scaffolded week 1. Module specs are stubs until their build week (see `ROADMAP.md`); a stub gaining content is the signal its build has started.
