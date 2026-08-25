#!/usr/bin/env bash
# Empties staging's domain tables and re-seeds them from the tenant template.
# Repeatable on purpose: contract tests run against the shared database and
# deposit residue every time CI runs, so this is a command we will want more
# than once rather than a one-off cleanup.
#
#   ./infra/reset-staging-data.sh            reports what it would remove
#   ./infra/reset-staging-data.sh --commit   removes it, then seeds the template
#
# What survives: staff_operators, staff_sessions, staff_login_attempts,
# audit_log, schema_migrations. The logins are in use and the week-2 audit trail
# is evidence. The full list, and why idempotency_keys is *not* on it, is in
# src/reset/contract.ts.
#
# Staging only, and there is no argument that changes that. Prod's data is the
# product; if it ever needs a reset, that is a decision with a runbook entry of
# its own, not a flag on this script.
set -euo pipefail

PROJECT="${PROJECT:-dona-v3}"
REGION="${REGION:-me-west1}"
ENV=staging
SQL_INSTANCE="dona-$ENV"
SECRET="$ENV-database-url"
CONNECTION_NAME="$PROJECT:$REGION:$SQL_INSTANCE"
TEMPLATE="docs/reference/tenant-table-template.csv"
PORT="${PROXY_PORT:-5433}"

COMMIT=""
if [[ "${1:-}" == "--commit" ]]; then
  COMMIT="--commit"
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--commit]" >&2
  exit 2
fi

say() { printf '\n▸ %s\n' "$1"; }

command -v cloud-sql-proxy >/dev/null 2>&1 || {
  echo "cloud-sql-proxy not installed. Install it with:" >&2
  echo "  gcloud components install cloud-sql-proxy" >&2
  exit 2
}

[[ -f "$TEMPLATE" ]] || {
  echo "missing $TEMPLATE — run from the repository root" >&2
  exit 2
}

say "Reading $SECRET"
# The connection URL is a secret and stays one: it is read into a variable, it
# is never echoed, and it is never written to a file. Cloud Run reaches the
# database over a unix socket, so the value names /cloudsql/<connection name> —
# which is also the only place the *environment* is written down, and therefore
# what makes the check below meaningful.
DATABASE_SECRET="$(gcloud secrets versions access latest \
  --secret="$SECRET" --project="$PROJECT")"

case "$DATABASE_SECRET" in
*"/cloudsql/$CONNECTION_NAME") ;;
*)
  echo "refusing: $SECRET does not name $CONNECTION_NAME" >&2
  exit 2
  ;;
esac

# Rewrite the socket URL into a TCP one pointing at the local proxy. Everything
# before the @ — user and password — is carried across untouched and unread.
CREDENTIALS="${DATABASE_SECRET#postgres://}"
CREDENTIALS="${CREDENTIALS%%@*}"
DB_NAME="${DATABASE_SECRET##*@/}"
DB_NAME="${DB_NAME%%\?*}"
DATABASE_URL="postgres://$CREDENTIALS@127.0.0.1:$PORT/$DB_NAME"
unset DATABASE_SECRET

say "Opening a tunnel to $CONNECTION_NAME on 127.0.0.1:$PORT"
# Authenticated as whoever is logged into gcloud — no key file, and the access
# is on that person's own credentials rather than the runtime service account's.
cloud-sql-proxy --port "$PORT" "$CONNECTION_NAME" &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  # The proxy prints "ready for new connections" before it is listening on some
  # machines, so wait on the port itself.
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
  sleep 1
done
nc -z 127.0.0.1 "$PORT" 2>/dev/null || {
  echo "proxy did not come up on 127.0.0.1:$PORT" >&2
  exit 1
}

if [[ -z "$COMMIT" ]]; then
  say "Dry run — nothing will be written. Re-run with --commit to apply."
fi

DATABASE_URL="$DATABASE_URL" npm run reset --silent -- "$TEMPLATE" $COMMIT
