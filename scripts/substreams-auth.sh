#!/usr/bin/env bash
# Exchange a Graph Market `server_` API key for the short-lived JWT the
# Substreams CLI actually consumes.
#
# The endpoints REJECT a raw `server_` key:
#   base.substreams.pinax.network:443 -> unauthenticated: invalid access token
#   base-mainnet.streamingfast.io:443 -> invalid JWT token
# See NOTES.md 7.1.
#
# Usage:  eval "$(./scripts/substreams-auth.sh)"
#    or:  export SUBSTREAMS_API_TOKEN="$(./scripts/substreams-auth.sh --raw)"
set -euo pipefail

AUTH_URL="${SUBSTREAMS_AUTH_URL:-https://auth.thegraph.market/v1/auth/issue}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO_ROOT/.env" ] && { set -a; . "$REPO_ROOT/.env"; set +a; }

KEY="${SUBSTREAMS_API_KEY:-}"
if [ -z "$KEY" ]; then
  echo "error: SUBSTREAMS_API_KEY is not set (expected a 'server_...' key from The Graph Market)" >&2
  exit 1
fi
case "$KEY" in
  server_*) ;;
  *) echo "warning: key does not start with 'server_'; exchanging anyway" >&2 ;;
esac

TOKEN="$(curl -sSf --max-time 30 -X POST "$AUTH_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"api_key\":\"$KEY\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"

[ -n "$TOKEN" ] || { echo "error: auth exchange returned no token" >&2; exit 1; }

if [ "${1:-}" = "--raw" ]; then
  printf '%s\n' "$TOKEN"
else
  printf 'export SUBSTREAMS_API_TOKEN=%s\n' "$TOKEN"
fi
