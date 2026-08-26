#!/usr/bin/env bash
# Puts a secret value into Secret Manager, or rotates one already there.
#
#   ./infra/set-secret.sh staging openai-api-key      prompts, hidden
#   ./infra/set-secret.sh prod    openai-api-key
#   pbpaste | ./infra/set-secret.sh staging openai-api-key      (piped)
#
# This is the one way a key enters this system. There is deliberately no other:
#
#   - Secret Manager is the single source of truth for staging and prod. The
#     repo has never held a credential and must not start; a .env file holds
#     local development values only, and is gitignored.
#   - The value is NEVER a command-line argument. Arguments land in shell
#     history, in `ps` output, and in any process listing a colleague can read.
#     It arrives on stdin or from a hidden prompt, and is unset on the way out.
#   - Every secret is per environment, so staging and prod cannot share a key by
#     accident: the name is always <env>-<what>.
#   - Access is granted to the environment's runtime service account and to
#     nothing else, per secret. app-staging cannot read prod's anything.
#
# Rotation is the same command. Secret Manager versions the value, so a new
# version supersedes the old without deleting it, and rolling back is adding the
# previous value again. What this script cannot do is push the new value into a
# running service -- see the note it prints when it finishes.
set -euo pipefail

PROJECT="${PROJECT:-dona-v3}"
REGION="${REGION:-me-west1}"

ENV="${1:-}"
NAME="${2:-}"
case "$ENV" in
staging | prod) ;;
*)
  echo "usage: $0 <staging|prod> <secret-name>" >&2
  echo "example: $0 staging openai-api-key" >&2
  exit 2
  ;;
esac
if [[ -z "$NAME" || ! "$NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "secret name must be lowercase letters, digits and dashes" >&2
  echo "usage: $0 <staging|prod> <secret-name>" >&2
  exit 2
fi

SECRET="$ENV-$NAME"
RUNTIME_EMAIL="app-$ENV@$PROJECT.iam.gserviceaccount.com"

say() { printf '\n▸ %s\n' "$1"; }

# Never echoed, never written to a file, never passed as an argument.
if [[ -t 0 ]]; then
  printf 'Value for %s (input hidden): ' "$SECRET" >&2
  read -rs VALUE
  printf '\n' >&2
else
  VALUE="$(cat)"
fi
# A trailing newline from a pipe or an editor is not part of the key, and a key
# with one appended fails authentication in a way that looks like a wrong key.
VALUE="${VALUE%$'\n'}"
if [[ -z "$VALUE" ]]; then
  echo "refusing to store an empty value" >&2
  exit 1
fi
trap 'unset VALUE' EXIT

if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  say "Rotating $SECRET"
else
  say "Creating $SECRET"
  gcloud secrets create "$SECRET" \
    --replication-policy=automatic --project "$PROJECT" >/dev/null
fi

printf '%s' "$VALUE" |
  gcloud secrets versions add "$SECRET" --data-file=- --project "$PROJECT" >/dev/null
unset VALUE

# Idempotent, and per secret rather than project-wide: the runtime account can
# read this one key and no other environment's.
gcloud secrets add-iam-policy-binding "$SECRET" \
  --member "serviceAccount:$RUNTIME_EMAIL" \
  --role roles/secretmanager.secretAccessor --project "$PROJECT" >/dev/null

VERSION="$(gcloud secrets versions list "$SECRET" --project "$PROJECT" \
  --filter='state:ENABLED' --sort-by=~name --limit=1 --format='value(name)')"

say "Stored"
echo "  secret:  $SECRET"
echo "  version: $VERSION"
echo "  reader:  $RUNTIME_EMAIL"

cat <<NOTE

A running revision keeps the value it started with.
Cloud Run resolves :latest when an instance starts, not when a version is added,
so a rotation reaches the service only when a new revision rolls. Either:

  merge anything to main            (staging redeploys, picks up the new value)
  gcloud run services update dona-$ENV --region $REGION --project $PROJECT \\
    --update-env-vars ROTATED_AT=\$(date +%s)

The second rolls a revision without a code change. Verify with the boot line in
the logs, which names what the service actually resolved.
NOTE
