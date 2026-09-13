# RedFlag_Trail MCP server

Five tools over the live x402 spend ledger. Every answer cites transaction hashes.

| Tool | What it answers |
|---|---|
| `spend_summary` | What did we spend, over what window, with whom |
| `vendor_risk` | Is this vendor registered, how exposed are we, what findings exist |
| `list_findings` | Open risk findings, each with the Privy rule it proposes |
| `backtest_rule` | What would this rule have blocked, and what would it block by mistake |
| `propose_enforcement` | The exact Privy rule JSON to block a vendor at signing time |

## Works against any fleet

Fleet membership is a **parameter**, never a hardcoded list:

- `payers` omitted &rarr; falls back to the local `fleet.json` (demo convenience)
- `payers: ["0x…","0x…"]` &rarr; scope to exactly those wallets, any fleet, no code change
- `payers: []` &rarr; explicitly ALL indexed payers, chain-wide

Those last two are deliberately distinct. Collapsing them would make "show me
everything" silently return only the demo fleet's numbers.

## Install

```bash
claude mcp add redflag-trail -- node --env-file=/ABS/PATH/.env /ABS/PATH/mcp/server.mjs
```

Requires `DATABASE_URL` pointing at a database populated by the papertrail sink
(see the repo README).

## Example

> what did we spend last month and who is risky

`spend_summary` returns totals plus top vendors with evidence hashes, and
flags how many payments have `payer != tx.from` — the misattribution that
naive `tx.from` accounting produces. `list_findings` then returns the risky
vendors, each carrying the policy rule that would block it and the backtest
showing what that rule would cost.
