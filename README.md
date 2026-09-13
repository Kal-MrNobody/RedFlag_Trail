# RedFlag_Trail

Reconstruct an AI agent fleet's x402 spend from live on-chain data, flag risky vendors, and
turn each finding into a wallet policy rule that a human quorum approves — and that then
blocks the next payment **at signing time**.

Built for ETHOnline 2026.

---

## The number that justifies this project

Streaming every x402 payment on Base over a 10,145-block window:

| | count | share |
|---|---|---|
| **`payer` ≠ `tx.from`** | **12,291** | **99.6 %** |
| `payer` == `tx.from` | 51 | 0.4 % |

In x402 the agent **signs** an EIP-3009 authorization and a **facilitator broadcasts** it. So
the on-chain `tx.from` is the facilitator, not the spender. Attributing agent spend by
`tx.from` misattributes **99.6 % of x402 payments on Base** to whichever facilitator relayed
them.

Measured, not assumed. Reproduce it: `./scripts/g0b-liveness.sh`

---

## What it does

```
   Base mainnet
        │
        │  Substreams (The Graph Market)
        ▼
┌───────────────────────────────────────────────────────────┐
│  papertrail  — composed Substreams package                │
│                                                           │
│   x402:map_events ──┐                                     │
│                     ├─▶ map_payments ──▶ store_vendor_…   │
│   erc20_tokens:…  ──┘        │          store_facilitator_│
│                              │                            │
│                    eth_call decimals()                    │
│                              ▼                            │
│                           db_out                          │
└───────────────────────────────────────────────────────────┘
        │  substreams-sink-sql
        ▼
   payments ── vendors ── vendor_registry ── findings ── backtests
        │                        ▲               │
        │            Agent0 / ERC-8004 subgraph  │
        │                                        │
        ├──▶ MCP server  (spend_summary, vendor_risk, list_findings,
        │                 backtest_rule, propose_enforcement)
        │
        └──▶ review console ──▶ backtest ──▶ human approve
                                                │
                                     2-of-2 key quorum
                                                ▼
                             POST /v1/policies/{id}/rules   (Privy)
                                                │
                                                ▼
                        agent signs the same payment ──▶ REFUSED
                                          (code: policy_violation)
```

See [`docs/architecture.svg`](docs/architecture.svg) for the rendered diagram.

---

## The loop, demonstrated

**One command runs the whole story on live data** — reconstruct spend → flag a vendor →
backtest → human quorum approves → the next payment is blocked at signing time:

```bash
node --env-file=.env scripts/e2e-demo.mjs
```

It reuses the real code paths (live ledger read, `lib/backtest.mjs`, a live Privy 2-of-2 key
quorum, and a real fleet agent signing against USDC on Base), is re-runnable (it resets its
own demo rule at both ends and leaves the fleet policies untouched), and degrades honestly —
with no Privy credentials it still runs the first three stages on live data and says why the
last two were skipped. A captured run is in
[`docs/demo-transcript.txt`](docs/demo-transcript.txt). The signing-gate proof at its core:

```
[before] agent-01 signing to <vendor>           -> SIGNED
         appended to 12 policies, no rule lost
[after ] agent-01 signing the IDENTICAL payload -> REFUSED (policy_violation)
[ctrl  ] agent-01 signing to a DIFFERENT vendor -> SIGNED
```

The agent is refused **by Privy, not by our code**. That distinction is the point: a gate in
our own client is something an agent routes around by not calling it. A policy refusal happens
inside the signer, so no signature is ever produced to hand to a facilitator.

And the approval is enforced server-side too — a policy owned by a 2-of-2 key quorum refuses
under-signed changes:

```
[unsigned] -> 401 Missing `privy-authorization-signature` header
[1-of-2]   -> 401 Number of signatures does not match the authorization threshold
[2-of-2]   -> ACCEPTED
```

Otherwise "a human quorum approves" would be a claim about our UI. Here the *server* rejects
the change, so bypassing our console does not bypass the control.

---

## Quick start

```bash
./scripts/bootstrap.sh          # substreams CLI, wasm target, sink, pinned packages
./scripts/db-up.sh              # local Postgres
cp .env.example .env            # fill in credentials

# 1. prove the substream is live and measure the attribution gap
./scripts/g0b-liveness.sh

# 2. build + sink the ledger
cd papertrail && cargo build --target wasm32-unknown-unknown --release
substreams pack substreams.yaml && substreams pack postgres/substreams.yaml
substreams-sink-sql setup "psql://…" postgres/papertrail-postgres-v0.1.0.spkg
substreams-sink-sql run    "psql://…" postgres/papertrail-postgres-v0.1.0.spkg <start:stop> \
  -e base-mainnet.streamingfast.io:443 --batch-block-flush-interval 50
cd .. && ./scripts/g1-verify.sh

# 3. enrich, score, review
node --env-file=.env scripts/g3-enrich.mjs
node --env-file=.env scripts/g3-risk.mjs
node --env-file=.env api/server.mjs        # console on :8787

# 4. enforce (after a human approves in the console)
node --env-file=.env scripts/g5-enforce.mjs <finding_id>
```

MCP: see [`mcp/README.md`](mcp/README.md).

---

## What is ours, precisely

Pinax already ships `evm-x402`, a flat 1:1 dump of x402 events to a table. **We do not claim
that category.** `papertrail` differs on specific axes:

| | `evm-x402` (Pinax) | `papertrail` (ours) |
|---|---|---|
| Composes x402 **+ erc20-tokens** | ✗ x402 only | ✓ |
| Computed facilitator allowlist | ✗ | ✓ — the x402 package explicitly applies none |
| Token `decimals` → normalised amount | ✗ | ✓ via batched `eth_call` |
| Vendor first-seen store | ✗ stateless | ✓ enables R2 |
| Payer-attributed ledger | ✗ raw dump | ✓ |

Composition is provable, not asserted: the packed spkg carries the imported x402 module at
hash `4aa30170e0d6f3b8ee5f58efce62dc55de751fda` — byte-identical to the standalone package,
so the exact upstream module is reused rather than copied.

---

## Things we refuse to overstate

These are deliberate. A risk tool that inflates its own certainty is worse than none.

- **Every payment is `confidence: "heuristic"`.** The upstream EIP-3009 reconstruction joins
  `AuthorizationUsed` + `Transfer` + calldata; Pinax labels the result heuristic and we carry
  that through to the `payments` table rather than dropping it. We *reconstruct* payments; we
  do not prove settlement.
- **`amount_usd` is NULL for anything that is not a USD stablecoin.** Decimals give a
  decimal-scaled amount, not a dollar value — that needs a price feed we do not have. So
  `SUM(amount_usd)` stays truthful and unpriced assets are visibly unpriced.
- **R4 (unknown facilitator) is advisory and says so.** The facilitator is not a field of the
  EIP-3009 message, so *no* signing-time rule can key on it. Claiming R4 enforcement would
  promise something the mechanism cannot deliver.
- **R1 skips loudly when the registry has not been checked**, instead of reporting "no
  unregistered vendors". Absence of data is not evidence of safety.
- **A finding cannot be approved before it is backtested** (HTTP 409). Approving a rule nobody
  has replayed is exactly the mistake this tool exists to prevent.

The backtest earns its keep by arguing *against* rules: on the busiest vendor in the ledger it
returns `would_block: 0` and flags a likely false positive, because 302 independent payers use
that vendor. The interesting output is the rule a human should **not** approve.

---

## Status

| Gate | Status |
|---|---|
| G0a Privy signature gating | **done** — refusal on an in-message field, 3/3 runs |
| G0b Substreams liveness | **done** — 12,351 live payments, 99.6 % attribution gap |
| G1 Ledger | **done** — 908 rows sunk, schema frozen |
| G2 Fleet | **done** — 8 real x402 payments settled on Base, 8/8 with `payer != tx.from`; 4 more refused live by our own G5 rule |
| G3 Brains | **built** — R1 needs a Subgraph Studio key |
| G4 Backtest | **done** |
| G5 Enforcement loop | **done** — 4 passes incl. 3 rehearsals, plus a live 2-of-2 quorum |
| G6 Surfaces | **done** — 5 MCP tools + review console |
| G7 Ship | **done** — Bazantic gateway + published Recipe; A/B shows the Recipe adds 13 verifiable tx-hash citations (vs 0) and 4 honesty guardrails ([`bazantic/ab-test.md`](bazantic/ab-test.md)) |

`PROGRESS.md` is the gate ledger. `NOTES.md` records every confirmed API shape with an
evidence grade, and every place a vendor's docs contradicted our assumptions.

## Network requirements

Live third-party APIs by design — mocked or local-only data disqualifies the Graph tracks.

| Host | For |
|---|---|
| `api.privy.io` | wallets, policies, key quorums |
| `base-mainnet.streamingfast.io:443` | Substreams (Graph Market) |
| `gateway.thegraph.com` | Agent0 / ERC-8004 subgraph |
| `base-mainnet.g.alchemy.com` | Base RPC (`decimals()`, broadcasts) |
| `raw.githubusercontent.com` | prebuilt Substreams packages |

⚠️ `substreams-sink-sql` speaks the native Postgres wire protocol on **5432**. A sandbox
limited to 443 cannot reach a hosted database at all — use a local Postgres there.
