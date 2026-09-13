#!/usr/bin/env bash
# Bring up the local Postgres G1 sinks into. Idempotent.
#
# An external/hosted Postgres is NOT usable from a sandbox whose egress is
# limited to 443 - substreams-sink-sql needs the native wire protocol on 5432.
# See NOTES.md 8.1.
set -euo pipefail

DB_NAME="${DB_NAME:-redflag}"
DB_PASS="${DB_PASS:-redflag}"

if ! pg_isready -q 2>/dev/null; then
  echo "starting postgresql..."
  service postgresql start >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pg_isready -q 2>/dev/null && break; sleep 1; done
fi
pg_isready || { echo "postgres failed to start" >&2; exit 1; }

sudo -u postgres psql -qc "ALTER USER postgres PASSWORD '${DB_PASS}';" >/dev/null
if ! sudo -u postgres psql -tAc "select 1 from pg_database where datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb "${DB_NAME}"
  echo "created database ${DB_NAME}"
fi

URL="postgresql://postgres:${DB_PASS}@127.0.0.1:5432/${DB_NAME}?sslmode=disable"
psql "$URL" -tAc 'select 1' >/dev/null
echo "ready: $URL"
