# Bazantic Recipe A/B test

**What this measures.** The Bazantic prize rewards a *Recipe* that measurably improves an
agent's behaviour over calling the raw tools. So this is a controlled experiment: the same
model gets the same task twice, against the same live tools and the same live data. The
**only** variable is the published Recipe. Anything the Recipe improves is attributable to
the Recipe and nothing else.

- **Model (both arms):** `claude-opus-5`
- **Task (both arms):** *"We run a fleet of AI agents that pay for services with x402. Over the last 30 days: what did the fleet spend, which vendors are risky, and should we block any of them? Give me a decision I can act on."*
- **Run locally?** Yes. See "Why local" and "Bazantic track eligibility" below.

## Design — what is held constant, what varies

| | Arm A (control) | Arm B (treatment) |
|---|---|---|
| Model | `claude-opus-5` | `claude-opus-5` (same) |
| Tools | 5, generated from `api/openapi.json` | 5, generated from `api/openapi.json` (same) |
| Live data | local Postgres via `api/server.mjs` | same Postgres, same API (same) |
| Base system prompt | neutral analyst role | neutral analyst role (same) |
| **Recipe** | **none** | **`agent-spend-audit` applied** |

The Recipe is applied exactly as Bazantic applies a published Recipe: its `description`
becomes an appended system prompt, and its `prompt_template` (with `{{inputs}}` filled)
becomes the user turn. Arm A gets the bare question instead.

### The tools are identical in both arms — this is the crux

A Bazantic gateway turns an OpenAPI spec into one callable tool per operation, naming and
describing each from the spec alone. `bazantic/ab/openapi-mcp-shim.mjs` does the same thing
locally: it reads `api/openapi.json` and registers one MCP tool per operation, with the
name, description and parameters taken **verbatim** from the spec (component schemas are
inlined into the tool description, as a gateway does). Nothing in the shim is hand-written
guidance. Both arms therefore see byte-identical tools — `getSpendSummary`,
`getVendorRisk`, `listFindings`, `backtestFinding`, `health` — and both hit the same
live ledger through them. If the shim leaked domain knowledge, the experiment would measure
the shim, not the Recipe.

### Isolation (so the arms differ *only* by the Recipe)

Both arms run as headless `claude -p` children with:
- **cwd = a fresh temp dir outside the repo.** `CLAUDE.md` discovery walks up the tree, so
  running under the repo would hand both arms this project's working agreement and rules
  of engagement — context a real API caller never has. (An earlier run *was* contaminated
  this way; the control cited `NOTES.md`/`PROGRESS.md` and produced a "What I need from
  you" section. Fixed, and both arms below are clean of it.)
- **All built-in tools denied** (Bash, Read, Write, Grep, WebFetch, Task, …). Verified from
  the transcripts: both arms *tried* Bash/Read to dump large tool outputs to disk and were
  refused ("No such tool available"). Neither could reach the repo's own notes and answer
  from them; both had to answer from the API.
- `--strict-mcp-config`, so only the shim's tools load.

## Result

Both arms reached the **same correct headline** — *block nothing* — because the OpenAPI tool
descriptions already carry the load-bearing domain facts (attribute by payer, backtest
before blocking, unchecked ≠ unregistered). That is the honest finding: a well-written spec
gets you a long way. **The Recipe's value is in the disciplines the spec cannot enforce.**

Scored objectively against the Recipe's own constraints (checks run by script over the two
final answers, not by eye):

| Criterion | Arm A (no Recipe) | Arm B (Recipe) |
|---|---|---|
| Attributes by `payer`, not `tx.from` | yes | yes |
| Explains the agent-signs / facilitator-broadcasts mechanism | yes | yes |
| Backtests before recommending a block | yes | yes |
| Reasons about false positives (independent payers) | yes | yes |
| Distinguishes UNCHECKED from unregistered | yes | yes |
| **Cites verifiable transaction hashes** | **0 hashes** | **13 hashes** |
| **States that nothing was enforced** | **no** | **yes** |
| **States enforcement needs human quorum approval** | **no** | **yes** |
| **Treats null `amount_usd` as unpriced, not zero** | **no** | **yes** |
| **Reports confidence as heuristic (reconstructed, not settled)** | **no** | **yes** |
| **Notes R4/facilitator findings are advisory (unenforceable at signing)** | **no** | **yes** |

Cost of the lift: Arm A 114s / \$0.7669; Arm B 140s /
\$0.8642 — the Recipe adds ~26s
and ~\$0.10 for the extra rigor.

### The delta that matters most: verifiable claims

The product's entire thesis is *"an unverifiable spend or risk claim is worthless."* Arm A
made confident dollar-and-vendor claims and cited **zero** transaction hashes — none of it
independently checkable. Arm B cited **13**, one or more per vendor it named. Only the Recipe
arm produced an audit a human could actually verify on-chain. That single behaviour is the
difference between a report you can take to a quorum and a report you have to take on faith.

The other four Recipe-only wins are the honesty guardrails: Arm A never said "nothing has
been enforced," never mentioned the human-quorum gate, treated `total_usd` as if complete
(it silently excludes unpriced payments), never flagged that every row is a *heuristic*
reconstruction, and never explained that facilitator (R4) findings can't be enforced at
signing time. Each of these is a way the control could mislead a decision-maker; the Recipe
closes all four.

### Where they tied, and why that's expected

Attribution, backtesting and unchecked-vs-unregistered are baked into the OpenAPI
*descriptions* (`payer_ne_txfrom`, the `backtestFinding` summary, the `getVendorRisk`
"UNCHECKED is not the same as unregistered" line). A capable model reads those and complies
without a Recipe. The Recipe earns its place on the constraints a tool schema *cannot* carry
— citation discipline and honesty about what the numbers do and don't mean.

## Reproduce

```bash
# 1. bring up the API over the live ledger
PORT=8791 node api/server.mjs &
# 2. run both arms (or AB_ONLY=B to re-run one)
RFT_API_BASE=http://localhost:8791 node bazantic/ab/run-ab.mjs
# 3. score
node -e '/* see the scoring script in commit message */'
```

Full transcripts (every tool call and both final answers) are in
`bazantic/ab/runs/results.json`, with raw streams in `arm-A.stream.jsonl` /
`arm-B.stream.jsonl`.

## Why local

Running the two arms through Bazantic's *hosted* gateway needs the gateway's `--endpoint`
to be a public HTTPS URL it can forward to. This build container's egress is port-443-only
and cloudflared's tunnel needs outbound TCP 7844 (verified failing its own preflight), so
the API cannot be exposed from here. The gateway therefore points at a placeholder upstream.
Everything else on the Bazantic side is real and passed server-side: spec parsing, tool
generation, Recipe binding validation, and 402 payment challenges. Running the A/B locally
reproduces exactly what the gateway would do to the tools (OpenAPI → one tool per operation)
and what a published Recipe does to the prompt — so the *measurement* is faithful even though
the transport is local.

## Bazantic track eligibility

| Requirement | Status | Evidence |
|---|---|---|
| Bazantic account | done | **Kal-MrNobody** (GitHub) / khushalshadija05@gmail.com |
| Gateway deployed & serving | done | `ulbnrohdjrg6dlid3hgvv6ptzm`, active, returns 402 payment challenges at `https://ulbnrohdjrg6dlid3hgvv6ptzm.bazgateway.com` |
| Recipe published | done | `agent-spend-audit`, model `anthropic/claude-opus-5`, bound to the gateway's four tools; binding validation passed |
| Recipe measurably improves behaviour | **done** | this A/B: +13 verifiable tx-hash citations and 4 honesty guardrails the raw spec does not produce |
| Username for prize attribution | provided | **Kal-MrNobody** |

**Honest caveat:** the gateway's *upstream* is a placeholder because this container cannot
expose a public host (see "Why local"). Repoint `--endpoint` at any public deployment of
`api/server.mjs` and the same Recipe drives the same improvement over the hosted path.
