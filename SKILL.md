---
name: redflag-trail
description: >
  Audit an AI agent fleet's x402 stablecoin spend from live on-chain data, identify risky
  vendors, and turn a finding into a wallet policy rule that blocks the next payment at
  signing time. Use when asked what agents spent, which vendors or facilitators are risky,
  what a proposed block would have cost, or to propose enforcement against a vendor.
---

# RedFlag_Trail

Agent spend auditing for x402, with enforcement that happens inside the signer.

## The one thing to get right

In x402 the agent **signs** an EIP-3009 authorization and a **facilitator broadcasts** it.
The on-chain `tx.from` is therefore the facilitator, **not** the spender.

Measured on Base: `payer` differs from `tx.from` on **99.6 %** of payments.

> **Always attribute spend by `payer`. Never by `tx.from`.**
> Using `tx.from` credits almost every payment to the wrong party.

The same asymmetry drives enforcement: constrain **`eth_signTypedData_v4`**, never
`eth_sendTransaction` — the agent never calls the latter.

## Tools

| Tool | Use it for |
|---|---|
| `spend_summary` | "What did we spend last month?" Totals, top vendors, evidence hashes. |
| `vendor_risk` | "Is this vendor safe?" Registry status, our exposure, open findings. |
| `list_findings` | "What's risky?" Each finding carries the policy rule it proposes. |
| `backtest_rule` | "What would blocking them cost?" Run this **before** proposing enforcement. |
| `propose_enforcement` | Produce the exact Privy rule JSON. Does **not** enforce. |

## How to use it well

**Cite hashes.** Every tool returns `evidence_tx`. A spend or risk claim without hashes
cannot be checked, so always pass them through to the user.

**Backtest before proposing.** `backtest_rule` returns `would_block` and `false_positives`.
A rule that blocks nothing is noise; a rule that blocks a vendor with many independent payers
is probably wrong. Report both numbers — the useful answer is often "do not enforce this".

**Scope the fleet explicitly.** `payers` omitted falls back to a local demo fleet. Pass
`payers: [...]` for a specific fleet, or `payers: []` for all indexed payers chain-wide.
These are different questions; do not use one to answer the other.

**Never claim enforcement happened.** `propose_enforcement` returns `enforced: false` and a
rule to POST. Applying it requires a human quorum approval in Privy. Say what was proposed,
not what was blocked.

## Reading the data honestly

- `confidence` is `"heuristic"` on every row. Payments are **reconstructed** from
  `AuthorizationUsed` + `Transfer` + calldata, not proven settled. Do not describe them as
  confirmed settlements.
- `amount_usd` is **NULL** unless the asset is a recognised USD stablecoin. Never treat NULL
  as zero — `amount_decimal` is the amount; USD is only meaningful with a price.
- A vendor with no `vendor_registry` row is **unchecked**, not unregistered. Say so.
- R4 findings are **advisory**: the facilitator is not part of the signed message, so no
  signing-time rule can block on it.

## Setup

```bash
claude mcp add redflag-trail -- node --env-file=/ABS/PATH/.env /ABS/PATH/mcp/server.mjs
```

Needs `DATABASE_URL` pointing at a database populated by the `papertrail` Substreams sink.
See the repo README.
