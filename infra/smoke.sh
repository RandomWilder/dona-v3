#!/usr/bin/env bash
# Is the service actually serving? One definition, used by both deploy
# workflows and by hand from docs/runbook-deploy.md.
#
#   ./infra/smoke.sh https://dona-prod-xxxx.me-west1.run.app
#
# Checks db:up as well as ok:true — a process that boots but cannot reach
# Postgres is "deployed but silently broken" (PIPELINE.md §5), and must fail
# the deploy rather than pass it.
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  echo "usage: $0 <service-url>" >&2
  exit 2
fi

ATTEMPTS="${SMOKE_ATTEMPTS:-10}"
DELAY="${SMOKE_DELAY:-3}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  BODY="$(curl -fsS --max-time 10 "$URL/health" 2>/dev/null)" || BODY=''
  if [[ "$BODY" == *'"ok":true'* && "$BODY" == *'"db":"up"'* ]]; then
    echo "smoke ok — $URL/health → $BODY"
    exit 0
  fi
  echo "  attempt $attempt/$ATTEMPTS: ${BODY:-<no response>}" >&2
  [[ "$attempt" -lt "$ATTEMPTS" ]] && sleep "$DELAY"
done

echo "SMOKE FAILED — $URL/health never returned ok:true with db:up" >&2
exit 1
