#!/usr/bin/env bash
# G1 exit criterion:
#   `select count(*), sum(amount_usd) from payments` returns live Base rows,
#   AND payer != facilitator on at least one row.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO_ROOT/.env" ] && { set -a; . "$REPO_ROOT/.env"; set +a; }
: "${DATABASE_URL:?DATABASE_URL not set - run ./scripts/db-up.sh}"

echo "=== G1 exit criterion ==="
psql "$DATABASE_URL" -c "select count(*) as payments, sum(amount_usd) as total_usd from payments;"

echo "=== payer != facilitator (the misattribution this project prevents) ==="
psql "$DATABASE_URL" -c "
select
  count(*)                                              as total,
  count(*) filter (where payer <> facilitator)          as payer_ne_facilitator,
  count(*) filter (where payer <> tx_from)              as payer_ne_txfrom,
  round(100.0 * count(*) filter (where payer <> tx_from) / nullif(count(*),0), 1) as pct_misattributed
from payments;"

echo "=== evidence: three rows a judge can check on basescan ==="
psql "$DATABASE_URL" -c "
select tx_hash, payer, recipient, facilitator, amount_decimal, amount_usd, confidence
from payments
where payer <> facilitator
order by block_num desc
limit 3;"

echo "=== amount_usd is NULL for non-stablecoins, not silently zero ==="
psql "$DATABASE_URL" -c "
select asset, count(*) as n, min(decimals) as decimals,
       count(amount_usd) as priced_rows, count(*) - count(amount_usd) as unpriced_rows
from payments group by asset order by n desc;"

echo "=== vendors first-seen store ==="
psql "$DATABASE_URL" -c "select count(*) as vendors from vendors;"

# Gate the exit explicitly rather than eyeballing the tables above.
read -r TOTAL NE <<<"$(psql "$DATABASE_URL" -tAF' ' -c \
  "select count(*), count(*) filter (where payer <> facilitator) from payments;")"

echo
if [ "${TOTAL:-0}" -gt 0 ] && [ "${NE:-0}" -gt 0 ]; then
  echo "G1 PASS - ${TOTAL} live payments, ${NE} with payer != facilitator."
else
  echo "G1 FAIL - total=${TOTAL:-0} payer!=facilitator=${NE:-0}"
  exit 1
fi
