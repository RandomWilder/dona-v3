# Runbook — deploy, release, roll back

Two environments, both on Cloud Run in **me-west1** (Tel Aviv — tenant data
stays in Israel). Neither is ever deployed by hand.

| | staging | prod |
|---|---|---|
| service | `dona-staging` | `dona-prod` |
| URL | https://dona-staging-ydabrrmura-zf.a.run.app | https://dona-prod-ydabrrmura-zf.a.run.app |
| trigger | merge to `main`, after CI passes | push a `v*` tag |
| workflow | `.github/workflows/deploy.yml` | `.github/workflows/release.yml` |
| instances | min 0 / max 3 | min 1 / max 5 |
| database | `dona-v3:me-west1:dona-staging` | `dona-v3:me-west1:dona-prod` |
| secret | `staging-database-url` | `prod-database-url` |
| runtime identity | `app-staging@dona-v3` | `app-prod@dona-v3` |
| deploy identity | `deploy-staging@dona-v3` | `deploy-prod@dona-v3` |
| backups | none (disposable) | daily 02:00 UTC, 7 retained |

Both authenticate by Workload Identity Federation. There are no long-lived
keys anywhere, and no secret values in this repo.

## Deploy to staging

Merge to `main`. Deploy triggers on **CI succeeding**, not on the push, so a
red commit cannot reach staging even for an admin pushing directly.

## Release to prod

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The Release workflow then, in order: re-runs the full CI gate on the tagged
commit (tags don't match CI's own push filter, so this is what proves the code
is green) → refuses to continue unless the tag is an ancestor of `origin/main`
→ builds and pushes the image tagged with the commit SHA, the version tag and
`prod` → deploys → **takes traffic** → smoke-tests.

Migrations are part of the deploy: `src/boot.ts` awaits `migrate()` before
`listen()`, so a bad migration fails the release instead of serving.

## Roll back

```bash
./infra/rollback.sh prod
```

Previous ready revision, traffic moved, smoke test run against it. Takes
seconds — no rebuild, no CI wait. To pick a specific revision:

```bash
./infra/rollback.sh prod dona-prod-00007-abc
```

Roll forward when the fix is out:

```bash
gcloud run services update-traffic dona-prod --to-latest --region me-west1
```

### The one trap: rollback pins traffic

By default the services follow "latest revision". `rollback.sh` pins traffic
to a named revision, and it stays pinned. A `gcloud run deploy` against a
pinned service creates a revision that serves **0% of traffic** — green
deploy, no change in production.

`release.yml` ends with `update-traffic --to-latest` for exactly this reason,
so the next tag release un-pins automatically. If you ever deploy by hand,
you own this step yourself.

## What `/health` is telling you

`version` is the **build's identity**, injected by whichever pipeline deployed it:

| where | `version` reads | injected by |
|---|---|---|
| prod | the release tag, e.g. `v0.1.0` | `release.yml`, from the tag |
| staging | the short commit, e.g. `4ce886f` | `deploy.yml`, from the merged SHA |
| local | `0.1.0-dev` from `package.json` | nothing — that is the fallback |

So a deployed URL reporting anything ending in **`-dev` means the injection did
not happen** and you are not looking at what you think you are. That is the
whole point of the fallback: before this, prod reported `0.1.0-dev` while
serving the `v0.1.0` release, and nothing on the outside could tell a release
from a hand-rolled deploy.

## Is it actually up?

```bash
./infra/smoke.sh https://dona-prod-ydabrrmura-zf.a.run.app
```

Requires `"ok":true` **and** `"db":"up"` — a process that boots but cannot
reach Postgres is a failure, not a pass. Same script runs in both deploy
workflows, so what CI checks and what you check by hand cannot drift.

Service URLs:

```bash
gcloud run services list --region me-west1 --project dona-v3
```

## Rebuild an environment from scratch

```bash
./infra/bootstrap.sh staging    # or: prod
```

Idempotent — describe-or-create throughout, and it never touches an existing
database password. Provisions APIs, Artifact Registry, Cloud SQL, the
connection secret, both service accounts, the private document bucket and the
WIF binding. The Cloud Run service itself is created by the first deploy, not by
this script.

Why prod has its own Cloud SQL instance rather than a second database on
staging's: `docs/decisions/ADR-0001-prod-database-isolation.md`.

## Reach a database from a laptop (slice 11.1)

Nothing outside the app had ever connected to staging's database: Cloud Run
reaches it over a unix socket, which a laptop does not have. The path is the
Cloud SQL proxy, authenticated as whoever is logged into `gcloud` — no key file,
and the access lands in the audit log under that person's own identity rather
than the runtime service account's.

Once, per machine:

```bash
gcloud components install cloud-sql-proxy
```

Two things that go wrong on a fresh machine, neither of them ours:

- The install finishes, and then the SDK offers to install its own bundled
  Python 3.13 and asks for a **sudo password**. The proxy is already installed by
  that point — cancel it. `cloud-sql-proxy --version` confirms.
- The proxy authenticates with **Application Default Credentials**, a different
  credential from the accounts in `gcloud auth list`. An expired ADC session
  fails as `invalid_grant … invalid_rapt`, which reads like a permissions
  problem and is not. Fix: `gcloud auth application-default login`.

Then, for an ad-hoc session:

```bash
cloud-sql-proxy --port 5433 dona-v3:me-west1:dona-staging
```

The database URL in Secret Manager names the socket
(`…?host=/cloudsql/dona-v3:me-west1:dona-staging`); through the proxy the same
user and password connect to `127.0.0.1:5433`. `infra/reset-staging-data.sh`
does that rewrite itself and never prints the secret.

## Reset staging's data (slice 11.1)

Makes staging *be* the mock building we designed — three buildings, ten units,
thirteen people — rather than whatever it has accumulated.

A note carried out of week 2 said staging held ~1,291 test buildings and ~1,000
test people. **Measured on day 11, it held one person and no buildings.** The
residue is real, but it lives on the developer's laptop and in CI's throwaway
service container, not here: CI runs against a Postgres container on `127.0.0.1`
that dies with the job, and nothing but the app has ever reached staging's
database. The hazard the note describes is still worth avoiding — the importer
keys a person by phone, so a dirty database returns the **wrong people**, three
of five lookups when it was measured — which is why this is a command rather
than a cleanup someone did once.

```bash
./infra/reset-staging-data.sh            # reports what it would remove
./infra/reset-staging-data.sh --commit   # removes it, then seeds the template
```

It empties the domain tables and re-seeds staging from
`docs/reference/tenant-table-template.csv` — three buildings, ten units, thirteen
people. **Staff logins, sessions, login attempts and the audit log survive**: the
logins are in use and the audit trail is evidence. `idempotency_keys` does *not*
survive, and that is deliberate — every key in it memoizes a domain command's
result, so leaving it behind would hand a re-import the id of a person who no
longer exists. The list, and the reasoning, live in `src/reset/contract.ts`.

Staging only. There is no argument that points it at prod, and the script checks
the connection name in the secret before it opens a tunnel to anything.

## The staff login (slice 5.2)

Bootstrap creates two secrets per environment — `<env>-staff-seed-email` and
`<env>-staff-seed-password`. The password is generated and handed straight to
Secret Manager: it is never echoed, never written to a file, never committed.
Every boot mounts both, and creates the operator **only if that email has no
account yet**.

Read the generated password once:

```bash
gcloud secrets versions access latest --secret=staging-staff-seed-password --project dona-v3
```

Prefer your own? Add a version **before the first deploy of that environment**:

```bash
printf '%s' 'a-password-of-at-least-12-characters' | gcloud secrets versions add staging-staff-seed-password --data-file=- --project dona-v3
```

**The trap:** seeding creates, it never updates. Once the operator exists, a new
password version changes nothing — the account keeps the password it was made
with. Rotation and a change-password flow are week 6. Until then, changing a
live operator's password means deleting the row and letting the next boot
re-seed, which is a deliberate act and not something a deploy will do for you.

If the password is too short, or only one of the two secrets is set, **boot
fails** and the revision never serves. That is on purpose: a deploy with no way
in, or with a weak way in, should be loud.

## Private document store (slice 7.0)

Real tenant documents — signed leases and what comes with them — live in a
per-environment bucket, never in this repo and never on a laptop as the only
copy:

```
gs://dona-v3-staging-docs
gs://dona-v3-prod-docs
```

Both are provisioned by `bootstrap.sh` and re-closed on every run. Four controls,
verified after each provision:

| control | why |
|---|---|
| **public access prevention: enforced** | the bucket cannot be made public, by anyone, ever — not a default that a later object can opt out of |
| **uniform bucket-level access** | no per-object ACLs, so access is decided in one place you can read at a glance |
| **versioning on** | an overwrite or deletion is recoverable; the object may be the only copy of a signed contract |
| **location `me-west1`** | Israeli tenants' documents stay in Israel |

Access is `roles/storage.objectViewer` **and, since slice 11.2,
`roles/storage.objectCreator`** on that one bucket, granted to that environment's
runtime account only — never a project-level storage role, so `app-staging`
cannot read prod's documents. `objectCreator` is the grant 7.0 deferred "until
the slice that needs it"; the admin lease upload is what needed it.

**What is still not granted is `objectAdmin`, which carries delete.** The app can
write a new object and read one, and it cannot destroy a signed contract. That
matters while there is no retention rule and no deletion path at all — see
*Retention* below.

Check it is still closed:

```bash
gcloud storage buckets describe gs://dona-v3-prod-docs --project dona-v3 --format="value(location,uniform_bucket_level_access,public_access_prevention,versioning_enabled)"
```

Expect `ME-WEST1  True  enforced  True`. An unauthenticated `curl` of any object
must return `403`, and a bucket listing `401`.

### Object paths carry no personal names

```
leases/bldg-<buildingId>/unit-<unitId>/tenancy-<tenancyId>/<kind>-<documentId>.pdf
```

Paths surface in logs, error messages and audit entries, which is exactly where
personal data must not appear (SPEC.md). The place identifies the document; the
people in it never do.

**The shape changed in slice 11.2, from a readable address to ids.** 7.0 wrote
this rule as `leases/bet-shemesh/harav-kook-48/bldg-204/unit-24/…`, transliterated
by hand for the one document uploaded by hand. Generating that shape means
transliterating Hebrew *in code*, and two streets that transliterate alike would
file one flat's lease under another's — a correctness failure with isolation
flavour, arriving quietly. Ids also do not rot: correcting a building's address
leaves every object still correctly filed, and objects cannot be cheaply renamed.

So the path is ids and the **database row is the index** from an address to an
object. To find a tenancy's documents, ask the database rather than the bucket:

```sql
SELECT object_path FROM occupancy_documents WHERE tenancy_id = '<id>';
```

The one hand-uploaded lease keeps its old readable path. It is grandfathered, not
migrated — moving it would break nothing and prove nothing.

Uploading is now the admin screen's job (`/admin/units/<id>`, an admin or
operator). By hand, with your own credentials, remains possible and is what the
first upload into a fresh environment uses:

```bash
gcloud storage cp "<local file>" "gs://dona-v3-prod-docs/leases/<path>" --project dona-v3
```

### Known gap: the default compute service account

`149055978002-compute@developer.gserviceaccount.com` holds `roles/editor` at
project level — a Google default — and can therefore read these documents
regardless of the bucket's own policy. Nothing uses it: Cloud Run runs as
`app-<env>`, and images are built in GitHub Actions. Removing that binding is a
project-wide IAM change and is a **week-6 hardening item**, recorded in
`tasks/todo.md`. Nobody holds `roles/viewer`, so the bucket's legacy viewer
binding grants no one anything today.

### Retention

There is no lifecycle rule. A signed lease is a legal record whose retention is
Dona Dom's to set, not ours to guess, and deleting one by policy would be worse
than keeping it. **This is a deliberate gap, not an oversight** — it needs a
retention period and a working deletion path before real tenants can exercise a
deletion request. Week 6, alongside the rest of the privacy work.

Encryption is Google-managed at rest; customer-managed keys (CMEK) and
data-access audit logs are not enabled.

## Not yet in place

Alerting beyond the billing budget, point-in-time recovery, private IP / VPC
connector, custom domains, and the "agent said something wrong" procedure —
all week 6 (`ROADMAP.md`). Until then the smoke test is the monitoring.
