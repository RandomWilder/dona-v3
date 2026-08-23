# Runbook — deploy, release, roll back

Two environments, both on Cloud Run in **me-west1** (Tel Aviv — tenant data
stays in Israel). Neither is ever deployed by hand.

| | staging | prod |
|---|---|---|
| service | `dona-staging` | `dona-prod` |
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

## Is it actually up?

```bash
./infra/smoke.sh https://dona-prod-xxxx.me-west1.run.app
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
connection secret, both service accounts and the WIF binding. The Cloud Run
service itself is created by the first deploy, not by this script.

Why prod has its own Cloud SQL instance rather than a second database on
staging's: `docs/decisions/ADR-0001-prod-database-isolation.md`.

## Not yet in place

Alerting beyond the billing budget, point-in-time recovery, private IP / VPC
connector, custom domains, and the "agent said something wrong" procedure —
all week 6 (`ROADMAP.md`). Until then the smoke test is the monitoring.
