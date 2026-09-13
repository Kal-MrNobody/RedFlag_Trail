# Demo video script — 3:30

Target 3:30. Timings are cumulative. Everything shown is live; no slides of results.

---

## 0:00–0:25 — The problem, stated as a number

> "This is every x402 payment on Base over a ten-thousand-block window. Twelve thousand
> payments. And on **99.6 %** of them, the address that actually spent the money is *not* the
> address in `tx.from`."

**Screen:** terminal running `./scripts/g0b-liveness.sh`, output landing live.

> "That's because x402 splits signing from broadcasting. The agent signs an EIP-3009
> authorization; a facilitator relays it. So `tx.from` is the facilitator. Every spend
> dashboard that reads `tx.from` is crediting almost every payment to the wrong party."

---

## 0:25–1:05 — The ledger

**Screen:** `papertrail/substreams.yaml`, scroll the `imports:` block.

> "papertrail composes two Graph Substreams packages — Pinax's x402 module and their
> erc20-tokens module — and adds the three things neither provides."

**Screen:** `substreams info papertrail-v0.1.0.spkg`, highlight the imported module hash.

> "That hash is byte-identical to the standalone x402 package. This isn't a fork — it's the
> same module, reused."

> "On top: a computed facilitator allowlist, because the upstream package deliberately applies
> none. Token decimals, sourced by `eth_call` — because erc20-tokens doesn't carry them, which
> we found the hard way. And a vendor first-seen store."

**Screen:** `./scripts/g1-verify.sh`

> "Nine hundred and eight live payments in Postgres. `payer` differs from `facilitator` on
> **99.7 %** — the same gap, now through the whole pipeline."

---

## 1:05–1:45 — Risk, and a backtest that argues back

**Screen:** review console at `localhost:8787`.

> "Each finding carries a proposed rule. Not a description of a rule — the actual JSON that
> gets POSTed to Privy. What a human approves is what gets enforced."

**Screen:** click **Backtest**.

> "Before anyone approves, we replay it over history. This one would block **zero** of our
> payments, and it targets a vendor **302 independent payers** use. So the backtest says:
> don't enforce this."

> "That's the point. The useful output is the rule you *shouldn't* approve."

---

## 1:45–2:35 — Enforcement, at signing time

**Screen:** split — console on the left, terminal on the right.

> "Now a finding that should be enforced. Approve it in the console."

**Screen:** run `scripts/g5-enforce.mjs <finding_id>`, let it play.

> "Before: the agent signs, fine. We append the rule to all twelve agent policies — verifying
> we added exactly one rule and lost none. Then the same agent signs the **identical**
> payload."

**Screen:** hold on `REFUSED (policy_violation)`.

> "Refused. By Privy, not by our code. That matters: a check in our own client is something an
> agent skips by not calling it. This happens inside the signer — the agent never obtains a
> signature to hand to a facilitator."

**Screen:** the control line.

> "And a different vendor still signs, so we know the rule is keyed on the recipient, not just
> switching signing off."

---

## 2:35–3:05 — The human quorum is real

**Screen:** `scripts/g5-quorum-setup.mjs` output.

> "Approval isn't our UI being polite. The policy is owned by a two-of-two key quorum.
> Unsigned change: rejected. One signature: rejected. Two: accepted. Privy enforces that
> server-side, so bypassing our console doesn't bypass the control."

---

## 3:05–3:30 — Any fleet, and what we won't claim

**Screen:** Claude with the MCP server attached.

> "Ask it: *what did we spend last month and who is risky?*"

**Screen:** the answer, with transaction hashes.

> "Every answer cites hashes you can check on Basescan. Fleet membership is a parameter, so
> this runs against anyone's agents, not just our demo."

> "Two things we deliberately don't claim. Every payment is marked `heuristic` — we
> reconstruct payments, we don't prove settlement. And `amount_usd` is null for anything
> that isn't a USD stablecoin, because decimals aren't a price."

**Screen:** README, on the 99.6 % table.

> "Attribution by `payer`. Enforcement at signing time. Both measured."

---

## Shot list

| # | Shot | Pre-req |
|---|---|---|
| 1 | `g0b-liveness.sh` live | Graph Market key |
| 2 | `substreams.yaml` imports + module hash | — |
| 3 | `g1-verify.sh` | sunk ledger |
| 4 | console: spend table + finding + policy diff | API running |
| 5 | console: Backtest click | a finding exists |
| 6 | `g5-enforce.mjs` full run | approved finding |
| 7 | `g5-quorum-setup.mjs` 3-line result | — |
| 8 | Claude + MCP answering the spend question | MCP registered |

**Do not** cut away from the `REFUSED (policy_violation)` line — it is the whole demo.
