#!/usr/bin/env bash
# G0b - Substreams liveness + the attribution claim, measured on live Base data.
#
# Streams x402 map_events from a Graph Market endpoint and reports how often
# `payer` (the real spender) differs from `tx.from` (the facilitator that
# relayed it). That gap is the project's whole premise. See NOTES.md 7.2.
#
# Usage: ./scripts/g0b-liveness.sh [BLOCK_WINDOW]     (default 10000)
set -euo pipefail

WINDOW="${1:-10000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO_ROOT/.env" ] && { set -a; . "$REPO_ROOT/.env"; set +a; }

ENDPOINT="${SUBSTREAMS_ENDPOINT:-base-mainnet.streamingfast.io:443}"
SPKG="$REPO_ROOT/vendor/x402-v0.1.0.spkg"
[ -s "$SPKG" ] || { echo "missing $SPKG - run ./scripts/bootstrap.sh first" >&2; exit 1; }

# A raw server_ key is rejected by the endpoints; it must become a JWT.
export SUBSTREAMS_API_TOKEN="$("$REPO_ROOT/scripts/substreams-auth.sh" --raw)"

OUT="$(mktemp -t g0b.XXXXXX.jsonl)"
trap 'rm -f "$OUT"' EXIT

echo "streaming last $WINDOW blocks from $ENDPOINT ..."
# -t 0 stops at chain head. The stream is allowed to be cut short by the
# timeout; any non-zero payment count already satisfies the gate.
timeout "${G0B_TIMEOUT:-300}" substreams run "$SPKG" map_events \
  -e "$ENDPOINT" -s "-$WINDOW" -t 0 -o jsonl > "$OUT" 2>/dev/null || true

python3 - "$OUT" <<'PY'
import json, sys, collections
tot=diff=same=empty=0
blocks=set(); assets=collections.Counter(); facils=set(); conf=collections.Counter()
ids=set(); example=None
for line in open(sys.argv[1]):
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except Exception: continue
    b=d.get('@block'); blocks.add(b)
    for t in (d.get('@data') or {}).get('transactions') or []:
        txfrom=(t.get('from') or '').lower()
        for lg in t.get('logs') or []:
            p=lg.get('payment')
            if not p: continue
            tot+=1
            payer=(p.get('payer') or '').lower()
            facils.add((p.get('facilitator') or '').lower())
            assets[(p.get('asset') or '').lower()]+=1
            conf[str(p.get('confidence'))]+=1
            ids.add(f"{t.get('hash')}:{lg.get('blockIndex')}")
            if not payer: empty+=1
            elif payer!=txfrom:
                diff+=1
                if example is None:
                    example={'block':b,'tx':t.get('hash'),'tx_from':txfrom,'payer':payer,
                             'recipient':(p.get('recipient') or '').lower(),'amount':p.get('amount')}
            else: same+=1

if tot==0:
    print("G0b FAIL - zero payments. Widen the window, or try another chain."); sys.exit(1)

pct = 100.0*diff/tot
print(f"\nblocks       : {len(blocks)}  ({min(blocks)} .. {max(blocks)})")
print(f"payments     : {tot}")
print(f"payer != tx.from : {diff}  ({pct:.1f}%)   <- misattribution avoided")
print(f"payer == tx.from : {same}")
print(f"payer empty      : {empty}")
print(f"distinct facilitators: {len(facils)}")
print(f"distinct assets      : {len(assets)}")
print(f"confidence           : {dict(conf)}")
print(f"payment_id collisions: {tot-len(ids)}  (tx_hash:blockIndex)")
if example:
    print("\nexample - tx.from is the facilitator, payer is the real spender:")
    for k,v in example.items(): print(f"  {k:11}= {v}")
print("\nG0b PASS - live payments streamed from a Graph Market endpoint.")
PY
