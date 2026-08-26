#!/usr/bin/env bash
# Asks an environment's database what its runtime user is allowed to do.
#
#   ./infra/db-capabilities.sh staging
#   ./infra/db-capabilities.sh prod
#
# Read-only: it runs SELECTs and nothing else. It exists because two slices have
# now wanted the same unverified fact -- whether the Cloud SQL user the app
# connects as may CREATE EXTENSION -- and guessing costs a failed migration at
# boot, which is a deployed revision that will not start.
#
#   week 3 (12.2)  pgvector, for embeddings
#   week 6         btree_gist, for the exclusion constraint that would stop two
#                  overlapping tenancies on one unit (SPEC-occupancy.md,
#                  "Not yet in place")
#
# Cloud SQL grants cloudsqlsuperuser to users created through the API, and that
# role may install extensions from Google's supported list -- but "should" is
# not "does", and a migration is the wrong place to find out.
set -euo pipefail

PROJECT="${PROJECT:-dona-v3}"
REGION="${REGION:-me-west1}"

ENV="${1:-}"
case "$ENV" in
staging | prod) ;;
*)
  echo "usage: $0 <staging|prod>" >&2
  exit 2
  ;;
esac

SQL_INSTANCE="dona-$ENV"
SECRET="$ENV-database-url"
CONNECTION_NAME="$PROJECT:$REGION:$SQL_INSTANCE"
PORT="${PROXY_PORT:-5435}"

say() { printf '\n▸ %s\n' "$1"; }

command -v cloud-sql-proxy >/dev/null 2>&1 || {
  echo "cloud-sql-proxy not installed. Install it with:" >&2
  echo "  gcloud components install cloud-sql-proxy" >&2
  exit 2
}

say "Reading $SECRET"
# The same handling reset-staging-data.sh uses: read into a variable, never
# echoed, never written to a file. The socket path in the value is also what
# proves which environment this is.
DATABASE_SECRET="$(gcloud secrets versions access latest \
  --secret="$SECRET" --project="$PROJECT")"

case "$DATABASE_SECRET" in
*"/cloudsql/$CONNECTION_NAME") ;;
*)
  echo "refusing: $SECRET does not name $CONNECTION_NAME" >&2
  exit 2
  ;;
esac

CREDENTIALS="${DATABASE_SECRET#postgres://}"
CREDENTIALS="${CREDENTIALS%%@*}"
DB_NAME="${DATABASE_SECRET##*@/}"
DB_NAME="${DB_NAME%%\?*}"
DATABASE_URL="postgres://$CREDENTIALS@127.0.0.1:$PORT/$DB_NAME"
unset DATABASE_SECRET

say "Opening a tunnel to $CONNECTION_NAME on 127.0.0.1:$PORT"
cloud-sql-proxy --port "$PORT" "$CONNECTION_NAME" &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
  sleep 1
done
nc -z 127.0.0.1 "$PORT" 2>/dev/null || {
  echo "proxy did not come up on 127.0.0.1:$PORT" >&2
  exit 1
}

say "Asking $ENV what it can do"
DATABASE_URL="$DATABASE_URL" node --input-type=module -e '
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

const who = await one("SELECT current_user, version() AS server");
const superuser = await one(
  "SELECT pg_has_role(current_user, $1, $2) AS member",
  ["cloudsqlsuperuser", "member"],
).catch(() => ({ member: null }));

const extensions = (
  await pool.query(
    `SELECT name, default_version, installed_version
       FROM pg_available_extensions
      WHERE name = ANY($1) ORDER BY name`,
    [["vector", "btree_gist"]],
  )
).rows;

console.log("user      ", who.current_user);
console.log("server    ", String(who.server).split(" ").slice(0, 2).join(" "));
console.log(
  "superuser ",
  superuser.member === null
    ? "role cloudsqlsuperuser not present"
    : superuser.member
      ? "yes — may CREATE EXTENSION from the supported list"
      : "NO — CREATE EXTENSION would fail at boot",
);
for (const row of extensions) {
  console.log(
    `extension  ${row.name} available ${row.default_version} · installed ${row.installed_version ?? "no"}`,
  );
}
if (extensions.every((row) => row.name !== "vector")) {
  console.log("extension  vector NOT AVAILABLE on this instance");
}
await pool.end();
'
