# ADR-0003 — API keys stay in Secret Manager; the admin controls the reference, never the value

- **Date:** 2026-09-01
- **Status:** accepted
- **Context slice:** raised during 14.1a, decided before any code

## Context

Slice 14.1a needed an embedding key locally and found none on the laptop. The
keys exist — `staging-openai-api-key` and `prod-openai-api-key`, in Secret
Manager since fuse 4 closed on 2026-08-26 — but nothing in the repo or the
developer's shell carries one, by design.

That prompted a broader question from the owner, and it is the right question to
ask before week 5 builds the admin settings screen:

> we should not plan the system to have a single, hard coded / or a single
> secret. this is something that the admin / management user should be able to
> plug in and modify when needed.

Two different things are bundled inside it, and they have opposite answers.

**(a) Rotation must not require a deploy.** True today, and a real defect. Fuse 4
already records the mechanism: Cloud Run resolves `:latest` when an *instance
starts*, not when a version is added, so a rotated key reaches the service only
when a new revision rolls. For a system an office operates, "the key was revoked,
ship a deploy" is not an operational answer.

**(b) An admin should type the key into a form.** This is the part that sounds
like more control and delivers less.

## Decision

1. **Secret material stays in Secret Manager. Permanently.** No API key is ever
   stored in `config_settings`, in any other table, or accepted through an admin
   form. `infra/set-secret.sh` remains the only way a credential enters this
   system, and rotation remains "add a version".
2. **The admin controls the *reference*, not the value.** Week 5's `catalog`
   settings screen gains `embedding.api_key_secret` (and its extraction sibling)
   as ordinary config rows holding a **secret name**. An operator may point the
   system at a different secret without a deploy; what they can never do through
   a screen is read or set a key.
3. **The key is read per call, with a short cache, from week 6.** Replacing the
   read-at-instance-start resolution in `src/boot.ts` closes the `:latest`
   gotcha: adding a version takes effect within the cache TTL, and rotation stops
   needing a revision roll. This is the change that actually answers (a).
4. **Nothing changes in week 3 or 4.** Not because it is unimportant — because
   changing how secrets are resolved mid-week, with no eval covering it, is the
   failure mode 14.1 was split to avoid (PIPELINE.md §9).

## Why an admin form for the value is a downgrade, not an upgrade

A key typed into a browser form crosses the browser, the request path, and the
application's error handling, and comes to rest in a database column. Compare
what each place gives:

| | Secret Manager | a `config_settings` row |
|---|---|---|
| access control | per-secret IAM grant | whoever can read the table |
| environment isolation | staging **cannot** read prod's key | one column, one database, no boundary |
| versioning | versions supersede; rollback is re-adding | last write wins |
| access audit | Cloud audit logs | none |
| exposure surface | one API, one service account | every screen, log and dump that reads settings |

The middle two rows are the load-bearing ones. Staging's service account cannot
read `prod-openai-api-key` today, and that separation is one of the few real
boundaries this system has. A row in the settings table erases it.

It also runs directly into SPEC.md's own security default — *"Secrets only via
env / Secret Manager — never in code, logs, or prompts"* — because a key in
`config_settings` sits in the same table as `embedding.model`, is read by the
same `settings.text()`, and is one debug dump or one error detail away from a
log line.

## What this decision does *not* settle

- **Multiple providers.** If "not a single key" also means more than one model
  provider, the seam already exists and this ADR does not constrain it:
  `Embedder` and `Extractor` are kernel ports, and the model id is already a
  config row (`kernel/config.ts`). A second provider is an adapter plus rows.
- **Who may change a reference row.** Week 5's settings screen needs its own
  answer on roles — pointing production at a different secret is a privileged
  act even when the value never appears.
- **A customer-supplied key.** If Dona Dom ever brings their own OpenAI account,
  the reference row is the right shape for it, but the onboarding path (who
  creates the secret, under whose IAM) is not designed here.

## Cost, stated

Deferring (a) to week 6 means that between now and then, a revoked or expired key
is fixed by rolling a revision rather than by an operator action. Staging and
prod both hold a working key at version 1, and neither has an expiry set, so the
realistic trigger is a compromise rather than a lapse — at which point a deploy
is being done anyway.

The CI key added in 14.1a is a third key and deliberately neither of the other
two, so a compromised Actions secret revokes on its own (`tasks/fuses.md`,
fuse 4).

## Alternatives considered

- **Key in `config_settings`, encrypted at rest.** Adds a key-encryption key that
  itself has to live somewhere, which is the original problem with an extra step,
  and still loses the per-environment IAM boundary.
- **Admin form that writes straight through to Secret Manager and never
  persists.** Genuinely better than a column, and still puts the plaintext value
  through the browser and the app process for no gain over the operator running
  `infra/set-secret.sh`. Worth revisiting only if a non-technical operator ever
  has to rotate without a shell.
- **Do nothing and leave rotation as a deploy.** Rejected: it is a real
  operational defect, and week 6 is where rotation work already lives.

## Next

- Week 5 (`catalog`): the settings screen, and `embedding.api_key_secret` as a
  reference row.
- Week 6 (hardening): per-call cached secret reads, retiring the read at instance
  start.
