#!/usr/bin/env bash
# Roll a Cloud Run service back to its previous revision. One command, no
# rebuild, no CI wait — this is what you run at 2am.
#
#   ./infra/rollback.sh prod                      # previous ready revision
#   ./infra/rollback.sh prod dona-prod-00007-abc  # a specific revision
#
# Deliberately not interactive: hesitating is the expensive part of an
# incident, and rolling back is the safe direction. It refuses to act only
# when it cannot work out where to go.
#
# After this runs, traffic is PINNED to the chosen revision — the service is
# no longer following "latest". Roll forward with the command it prints.
set -euo pipefail

ENV="${1:-}"
case "$ENV" in
staging | prod) ;;
*)
  echo "usage: $0 <staging|prod> [revision]" >&2
  exit 2
  ;;
esac

PROJECT="${PROJECT:-dona-v3}"
REGION="${REGION:-me-west1}"
SERVICE="dona-$ENV"
TARGET="${2:-}"

SERVING="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT" \
  --format='value(status.traffic[0].revisionName)')"
if [[ -z "$SERVING" ]]; then
  echo "cannot determine the revision $SERVICE is currently serving" >&2
  exit 1
fi

if [[ -z "$TARGET" ]]; then
  READY="$(gcloud run revisions list --service "$SERVICE" \
    --region "$REGION" --project "$PROJECT" \
    --sort-by='~metadata.creationTimestamp' \
    --filter='status.conditions.type=Ready AND status.conditions.status=True' \
    --format='value(metadata.name)')"
  # Walk newest-first to the entry after the one serving traffic.
  seen=''
  while IFS= read -r rev; do
    [[ -z "$rev" ]] && continue
    if [[ -n "$seen" ]]; then
      TARGET="$rev"
      break
    fi
    [[ "$rev" == "$SERVING" ]] && seen=1
  done <<<"$READY"
fi

if [[ -z "$TARGET" ]]; then
  echo "no previous ready revision to roll $SERVICE back to (serving: $SERVING)" >&2
  echo "ready revisions:" >&2
  echo "${READY:-<none>}" >&2
  exit 1
fi

echo "▸ $SERVICE: $SERVING → $TARGET"
gcloud run services update-traffic "$SERVICE" \
  --to-revisions "$TARGET=100" \
  --region "$REGION" --project "$PROJECT" --quiet

URL="$(gcloud run services describe "$SERVICE" \
  --region "$REGION" --project "$PROJECT" --format='value(status.url)')"

# A rollback that lands on a broken revision is not a rollback.
"$(dirname "$0")/smoke.sh" "$URL"

cat <<MSG

▸ $SERVICE is now serving $TARGET, and traffic is PINNED to it.
  The next tag deploy un-pins it automatically (release.yml ends with
  --to-latest). To roll forward by hand:

    gcloud run services update-traffic $SERVICE --to-latest --region $REGION --project $PROJECT
MSG
