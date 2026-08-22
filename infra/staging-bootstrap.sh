#!/usr/bin/env bash
# Provisions the staging environment on GCP. Idempotent — safe to re-run.
# Infrastructure lives here rather than in console clicks so it is reproducible.
#
#   ./infra/staging-bootstrap.sh
#
# The Cloud Run service itself is created by the first deploy, not here.
set -euo pipefail

PROJECT="${PROJECT:-dona-v3}"
REGION="${REGION:-me-west1}"
GITHUB_REPO="${GITHUB_REPO:-RandomWilder/dona-v3}"

REPO=dona
SQL_INSTANCE=dona-staging
DB_NAME=dona
DB_USER=dona
SECRET=staging-database-url
RUNTIME_SA=app-staging
DEPLOY_SA=deploy-staging
POOL=github-pool
PROVIDER=github-provider

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_EMAIL="$RUNTIME_SA@$PROJECT.iam.gserviceaccount.com"
DEPLOY_EMAIL="$DEPLOY_SA@$PROJECT.iam.gserviceaccount.com"
CONNECTION_NAME="$PROJECT:$REGION:$SQL_INSTANCE"

say() { printf '\n▸ %s\n' "$1"; }

say "Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project "$PROJECT"

say "Artifact Registry"
gcloud artifacts repositories describe "$REPO" \
  --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location "$REGION" \
    --description="dona-v3 container images" \
    --project "$PROJECT"

# --edition=ENTERPRISE is required: me-west1 defaults new instances to
# ENTERPRISE_PLUS, which rejects shared-core tiers like db-f1-micro.
say "Cloud SQL (first run takes several minutes)"
gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --edition=ENTERPRISE \
    --tier=db-f1-micro \
    --region="$REGION" \
    --storage-size=10GB \
    --storage-type=SSD \
    --availability-type=zonal \
    --project "$PROJECT"

gcloud sql databases describe "$DB_NAME" \
  --instance "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud sql databases create "$DB_NAME" \
    --instance "$SQL_INSTANCE" --project "$PROJECT"

say "Database user and connection secret"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  secret already exists — leaving password untouched"
else
  # Generated here and handed straight to Secret Manager: never echoed, never
  # written to a file, never committed.
  DB_PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)"
  gcloud sql users create "$DB_USER" \
    --instance "$SQL_INSTANCE" --password "$DB_PASSWORD" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud sql users set-password "$DB_USER" \
      --instance "$SQL_INSTANCE" --password "$DB_PASSWORD" --project "$PROJECT" >/dev/null
  # node-postgres reads ?host=... as a unix socket directory, which is how
  # Cloud Run reaches Cloud SQL.
  printf 'postgres://%s:%s@/%s?host=/cloudsql/%s' \
    "$DB_USER" "$DB_PASSWORD" "$DB_NAME" "$CONNECTION_NAME" |
    gcloud secrets create "$SECRET" \
      --data-file=- --replication-policy=automatic --project "$PROJECT"
  unset DB_PASSWORD
fi

say "Service accounts"
for sa in "$RUNTIME_SA" "$DEPLOY_SA"; do
  gcloud iam service-accounts describe "$sa@$PROJECT.iam.gserviceaccount.com" \
    --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" \
      --display-name "$sa" --project "$PROJECT"
done

# Runtime: reach the database, read its own secret. Nothing else.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$RUNTIME_EMAIL" \
  --role roles/cloudsql.client --condition=None >/dev/null
gcloud secrets add-iam-policy-binding "$SECRET" \
  --member "serviceAccount:$RUNTIME_EMAIL" \
  --role roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null

# Deploy: push images, roll revisions, act as the runtime account.
for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$DEPLOY_EMAIL" \
    --role "$role" --condition=None >/dev/null
done

say "Workload Identity Federation (no long-lived keys)"
gcloud iam workload-identity-pools describe "$POOL" \
  --location=global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" \
    --location=global --display-name="GitHub Actions" --project "$PROJECT"

# The attribute condition is the security control: without it, any repository
# on GitHub could mint a token for this project.
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --workload-identity-pool="$POOL" --location=global --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --workload-identity-pool="$POOL" \
    --location=global \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '$GITHUB_REPO'" \
    --project "$PROJECT"

gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_EMAIL" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" \
  --project "$PROJECT" >/dev/null

say "Done — values used by .github/workflows/deploy.yml"
echo "  provider:     projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "  deploy SA:    $DEPLOY_EMAIL"
echo "  runtime SA:   $RUNTIME_EMAIL"
echo "  sql instance: $CONNECTION_NAME"
