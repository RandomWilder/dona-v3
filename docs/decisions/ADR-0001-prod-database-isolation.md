# ADR-0001 — Prod gets its own Cloud SQL instance

- **Date:** 2026-08-23
- **Status:** accepted
- **Context slice:** 4.2 (prod + rollback rehearsed)

## Context

`ROADMAP.md` planned one Cloud SQL instance hosting an `app_staging` and an
`app_prod` database. Slice 4.1 built the first half of that: instance
`dona-v3:me-west1:dona-staging`, one database `dona`, POSTGRES_16, db-f1-micro,
ENTERPRISE edition (me-west1 rejects shared-core tiers on ENTERPRISE_PLUS).

Slice 4.2 needs a production database. Following the roadmap literally meant
adding a second database to that instance.

## Decision

Prod gets its own instance, `dona-v3:me-west1:dona-prod`, same shape as
staging, with its own database user, its own Secret Manager secret
(`prod-database-url`), and its own runtime service account (`app-prod`) which
is the only identity granted `secretAccessor` on that secret.

`ROADMAP.md`'s architecture table is amended to match.

## Why

1. **Blast radius.** Staging exists to be broken: wiped, restored, migrated
   against, load-tested. On a shared instance every one of those actions puts
   production tenant data — lease documents, tenant phone numbers — inside the
   same failure domain. A db-f1-micro has one shared core; a runaway staging
   query is a prod outage.
2. **Restores are instance-level.** Cloud SQL backup restore replaces the whole
   instance, not one database. Restoring staging to yesterday would take prod
   with it, which makes the one recovery path we have unusable.
3. **Credential isolation is real, not nominal.** Separate instances mean the
   staging connection URL cannot reach prod data even if it leaks. Two
   databases on one instance share a network endpoint and a superuser.
4. **Names that lie become incidents.** "Production data lives in an instance
   called `dona-staging`" is exactly the sentence someone misreads at 2am while
   following a runbook.

## Cost

About $10/month for a second db-f1-micro (10GB SSD, zonal, me-west1), plus
7-day automated backups on the prod instance only. Combined with prod Cloud
Run at `min-instances 1`, slice 4.2 adds roughly $20–30/month against the
₪500/month budget alert set in slice 1.1. Isolation of tenant PII is worth
more than $10.

## Consequences

- Two instances to provision, migrate and pay for. `infra/bootstrap.sh` takes
  the environment as an argument so they cannot drift.
- Migrations run per environment at boot (`src/boot.ts` awaits `migrate()`
  before `listen()`), so both instances converge on the same schema without
  extra machinery.
- Prod carries automated backups; staging does not. Point-in-time recovery on
  prod is deliberately deferred to the week-6 hardening slice.
- Neither instance has a private IP or VPC connector yet; both are reached
  over the Cloud SQL unix socket from Cloud Run. Also week 6.
