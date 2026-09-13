# PROGRESS

One line per gate. Status is one of: `blocked`, `in progress`, `done`.

| Gate | Status | Verify command | Result |
|---|---|---|---|
| G0a Privy signature gating | **done** ✅ | `node --env-file=.env scripts/g0a-signature-gate.mjs` | **PASS.** Sign → 200; append DENY on `message.to`; identical payload → **400 `policy_violation`**; different vendor, same wallet → 200. Deterministic over 3 runs. Fallback NOT needed |
| G0b Substreams liveness | **done** ✅ | `./scripts/g0b-liveness.sh` | **PASS.** 12,351 live payments over 10,145 Base blocks via a Graph Market endpoint. `payer != tx.from` on **99.6 %** of them; `payer` never empty; 0 `payment_id` collisions |
| G1 Ledger | **done** ✅ | `./scripts/g1-verify.sh` | **PASS.** 908 live Base payments, sum(amount_usd)=5065.56; `payer != facilitator` on 905 (99.7%); 0 payment_id collisions; 183 vendors. Schema FROZEN |
| G2 Fleet | **done** ✅ | `node --env-file=.env scripts/g2-pay.mjs` | **PASS.** 8 real x402 payments settled on Base, **8/8 with `payer != tx.from`**. 4 more refused live by our own G5 policy rule |
| G3 Brains | **done** ✅ | `node --env-file=.env scripts/g3-enrich.mjs && node --env-file=.env scripts/g3-risk.mjs` | **PASS.** 230 vendors enriched against the live ERC-8004 subgraph: 2 registered, 228 not. 228 R1 findings, $5,000.57 exposure, each carrying enforceable Privy rule JSON |
| G4 Backtest | **done** ✅ | `curl -X POST localhost:8787/v1/findings/{id}/backtest` | **PASS.** Returns `would_block {count,usd,tx[]}` + `false_positives {count,vendors[]}`. Correctly advises against enforcing a vendor with 302 independent payers |
| G5 Enforcement loop | **done** ✅ | `node --env-file=.env scripts/g5-enforce.mjs <finding_id>` | **PASS ×4.** Agent signs → rule appended to 12 policies → identical payload **REFUSED (policy_violation)** → different vendor still signs. Plus a real **2-of-2 key quorum**: Privy refuses unsigned and 1-of-2 changes |
| G6 Surfaces | **done** ✅ | `node /tmp/mcp-test.mjs` / open `localhost:8787` | **PASS.** 5 MCP tools verified over stdio JSON-RPC on the 908-row ledger; single-page console renders spend table, finding detail, policy diff, approve — no chart library, no theming |
| G7 Ship | **done** ✅ | `RFT_API_BASE=http://localhost:8791 node bazantic/ab/run-ab.mjs` | **PASS.** Bazantic gateway serving 402s + published Recipe `agent-spend-audit`; controlled A/B (same model, same OpenAPI-generated tools, same live ledger, Recipe the only variable) shows the Recipe adds **13 verifiable tx-hash citations vs 0** and 4 honesty guardrails (nothing-enforced, quorum gate, unpriced≠0, heuristic confidence) the raw spec never produces. Both arms isolated from repo CLAUDE.md |

## Gate log

### 2026-09-12 — G0a opened
- Scaffolded repo, `.gitignore`, `.env.example`.
- Attempted to confirm the Privy policy condition schema per the "never invent an API
  field" rule. Three fetches, all blocked (NOTES.md §1.1).
- Search established that a `ethereum_typed_data_message` `field_source` exists and takes a
  `typed_data` parameter — the mechanism G0a depends on — but the verbatim shape is
  unconfirmed, so no code was written.
- **Stopped per rules of engagement** (two failed verifies ⇒ ask, do not improvise).

### 2026-09-12 — G0a unblocked, schema confirmed
- `docs.privy.io` still egress-blocked. Routed around it by reading Privy's **own published
  SDK source** on GitHub (`privy-io/node-sdk`), which is the wire format itself — a stronger
  source than the docs.
- **`EthereumTypedDataMessageCondition` confirmed.** A policy rule CAN key on a field inside
  an EIP-712 message. G0a's premise holds; the README fallback is not needed.
- Two corrections to the brief recorded (NOTES.md §1.5, §1.6): the "version guard" does not
  exist as an API field, and the EIP-3009 field is `to`, not `recipient`.
- Wrote `scripts/g0a-signature-gate.mjs`. Syntax-checked. Blocked only on credentials.

### 2026-09-12 — G0a blocked at the network layer
- Credentials received and written to gitignored `.env` (verified via `git check-ignore`).
- First live run failed at step 1, before any Privy logic was exercised:

      403 Host not in allowlist: api.privy.io.
      Add this host to your network egress settings to allow access.

- This is **not** a credential or code failure. The sandbox egress policy does not permit
  `api.privy.io`, the same class of block that hid `docs.privy.io`.
- Not retried: the error is deterministic, so a retry spends a cycle for no information.
- **Unblocks when the environment's egress allowlist includes the hosts in README "Network
  requirements".**

### 2026-09-12 — session 2: egress restored, both G0 gates verified as far as credentials allow

- **The egress block is gone.** Re-tested at session start: `api.privy.io` answers (404 at
  `/`, i.e. the API, not the proxy), `docs.privy.io` is 200, and every other partner host
  resolves. Node's built-in `fetch` reaches Privy too. NOTES.md §4.1.
- **`.env` did not survive the container.** The credentials the previous session received
  are gone; the container is reclaimed between sessions. This is now the only G0a blocker.
- **G0a script verified against the wire format, not just re-read.** Pulled Privy's own
  `node-sdk` source and confirmed every call the script makes. Closed a real bug risk: the
  RPC param is `typed_data` with `primary_type` (snake_case), while `domain` is a free-form
  passthrough that must keep EIP-712 camelCase. The script already had both right. §4.3
- **G0b groundwork done without credentials.** Installed `substreams` v1.16.6, pulled the
  genuine `x402-v0.1.0.spkg`, and inspected it. `map_events -> proto:evm.x402.v1.Events`
  confirmed, and the package doc states verbatim that it applies no facilitator filtering —
  confirming our contribution. All 13 `Payment` fields confirmed from the descriptor. §4.5
- **Schema correction found for G1.** `Payment` is nested at
  `Events.transactions[].logs[].payment`; `transaction.from` (the facilitator) sits one level
  above `payment.payer` (the real spender). The nesting makes the misattribution bug the
  brief warns about easy to write by accident. §4.6
- **Open before the G1 schema freeze:** the proto has `Log.block_index` and `Log.ordinal`
  but no `log_index`, so `payment_id = tx_hash:log_index` needs a live row to settle. §4.7
- Stopped to ask for credentials rather than improvise.

### 2026-09-12 — session 2 addendum: a G1 assumption in the brief does not hold

Investigated the G1 composition before writing any of it, and found a blocker worth
surfacing now rather than at G1:

- **`erc20-tokens` does not carry `decimals`.** The brief's G1 specifies "USD normalisation
  via token decimals" from that package. It has 66 message types, all protocol-specific
  admin/lifecycle events (USDC mint/burn/blacklist/AuthorizationUsed, USDT, WBTC, SAI,
  stETH, WETH) — no `decimals`, no `symbol`, not even a plain ERC-20 `Transfer`.
- **No prebuilt Pinax package has it.** Checked five (`erc20-tokens`, `erc20-transfers`,
  `erc20-balances`, `evm-contracts`, `evm-transfers`): zero occurrences of `decimals`.
- **Proposed resolution** (NOTES.md §5.3): source `decimals()` with an `eth_call` per
  newly-seen asset, memoised in a store, built as a standalone reusable
  `store_token_decimals` module. Pinax already does RPC-from-module in `erc20/balances`, so
  it is idiomatic. This converts the gap into a *reusable composable module*, which is
  exactly what The Graph's Composable track rewards. Hardcoding `USDC = 6` is rejected
  because G6 requires the tooling to work against any fleet.
- **Good news for the composition story:** Pinax's `evm-transfers` aggregator composes
  erc20_transfers + erc20_tokens + native_transfers and does *not* include the x402 package.
  So composing `x402:map_events` with `erc20_tokens:map_events` is genuinely novel work.
- **Good news for ground truth #1:** Base is an EXTENDED-detail chain, so the trace-dependent
  `transferWithAuthorization` calldata decode — which is what makes `payer` trustworthy — is
  available on our target chain. Confirm `payer` is non-empty on the first live G0b row.

### 2026-09-12 — G0a PASSED

Credentials arrived; ran the kill test live against `api.privy.io`.

```
[3] Sign TransferWithAuthorization to 0x…dEaD          -> 200 SIGNED
[4] Append DENY on message.to == 0x…dEaD               -> rule created
[5] Sign the BYTE-IDENTICAL payload again              -> 400 REFUSED  (policy_violation)
[6] Sign to a DIFFERENT vendor, same wallet + policy   -> 200 SIGNED
```

**The mission's central mechanism is confirmed real.** Privy refuses a signature based on a
field *inside* the EIP-712 message, server-side, at signing time. The agent never obtains a
signature to hand to a facilitator. The README fallback is not needed and has been dropped.

Step 6 was added during the run and is load-bearing: steps 1–5 alone would look identical if
the DENY were blocking *all* typed-data signing, so the control proves the rule is keyed on
`to` specifically. It immediately caught a false signal (see below).

Findings recorded in NOTES.md §6:

- **Four API constraints the SDK types do not express** (all found via live 400s): typed-data
  rules need ≥1 condition, so there is no blanket ALLOW; `chainId` rejects operator `in`;
  `chainId` values must be numerical strings; rule names are capped at 50 chars, so G3 must
  generate names from a truncated address.
- **Privy validates addresses against their EIP-55 checksum** and rejects a mismatch with
  `invalid_data` *before* the policy engine runs. Both that and a real refusal are 400s, so
  the assertions now require `code === 'policy_violation'` — otherwise the test could report
  a result for entirely the wrong reason. This is exactly what step 6 caught.
- **Policy address matching is case-insensitive — verified, not assumed.** Our substreams
  emits lowercase and agents may sign checksummed; had this been case-sensitive, every rule
  G3 generates would have silently failed open. A lowercase rule refuses a checksummed
  payload. No normalisation layer needed.
- Rules carry a server-assigned `id`, so `DELETE /v1/policies/{id}/rules/{rule_id}` gives G5
  a rollback path for a mistaken enforcement.

Next: G0b, which needs the Graph Market endpoint + token.

### 2026-09-12 — G0b PASSED, and it validates the project's core claim

Streamed `x402-v0.1.0.spkg map_events` from `base-mainnet.streamingfast.io:443` using a
Graph Market key. 10,145 blocks processed, exit 0.

```
payments         : 12,351
payer != tx.from : 12,291  (99.6 %)
payer == tx.from :     51  ( 0.4 %)
payer empty      :      0
```

**Ground truth #1 is now an empirical finding, not an assumption.** In every inspected row
`facilitator == tx.from` exactly while `payer` is an unrelated address, so attributing spend
by `tx.from` would misattribute **99.6 % of all x402 payments on Base** to whichever
facilitator relayed them. Reproduced at 99.6 % on a second independent window via
`scripts/g0b-liveness.sh`. This number belongs in the README and the video.

Other findings (NOTES.md §7):

- **`[CORRECTION]` the API key is not the API token.** A `server_` key is rejected by the
  endpoints outright; it must be exchanged for a JWT at `auth.thegraph.market/v1/auth/issue`.
  `.env` now separates `SUBSTREAMS_API_KEY` (durable) from `SUBSTREAMS_API_TOKEN` (the JWT),
  and `scripts/substreams-auth.sh` does the exchange. The key is rejected by
  `auth.pinax.network`, which confirms it is a Graph Market key — the provider the prize
  rules require.
- **`payer` is never empty** (0 / 12,351), confirming the §5.6 prediction that Base's
  EXTENDED detail level makes the trace-dependent decode reliable.
- **USDC on Base verified on-chain** (12,341 / 12,351 payments) — ground truth #3 upgraded
  from `[PROMPT]` to observed. A second asset also appeared, which is exactly why hardcoding
  decimals is the wrong call.
- **418 distinct facilitators** in ~5.5 hours, so R4 will fire on real data, not just planted
  data.
- **⚠️ every payment is `confidence: "heuristic"`** — a string, and nothing is "exact". We
  reconstruct payments rather than prove settlement, so `confidence` must be carried into the
  `payments` table and surfaced at G6 rather than quietly dropped.
- **§4.7 resolved:** both `(block, blockIndex)` and `(tx_hash, ordinal)` are collision-free
  over 12,351 rows. Freeze `payment_id = tx_hash:blockIndex` at G1 — `blockIndex` is the
  receipt log index a judge can verify on an explorer; `ordinal` is a Firehose counter that
  cannot be.

Both G0 kill tests are now passed. Next: G1.

### 2026-09-12 — G1 environment: self-served, nothing was actually blocking

I had flagged `BASE_RPC_URL` and `DATABASE_URL` as things to ask for. Checked before asking,
and both were self-servable, so G1 is unblocked with no input needed:

| Piece | Status |
|---|---|
| Base RPC | `https://mainnet.base.org` — verified with a live `eth_call`: `decimals()` on USDC returns **6** |
| Postgres | server 16 was installed but down; started it, created `redflag` DB |
| Rust wasm | `rustup target add wasm32-unknown-unknown` |
| `substreams-sink-sql` | v4.6.0 installed |
| `substreams` CLI | v1.16.6 (already) |
| Graph Market auth | working via `scripts/substreams-auth.sh` |

The `decimals()` call succeeding on the public endpoint also **validates the §5.3 plan** for
`store_token_decimals` before a line of it is written — the eth_call approach works.

⚠️ Two caveats, neither blocking now but both real for the demo:
- The container is **ephemeral**, so the local Postgres dies with the session. Fine for
  building and for G1's verify; a hosted DB is needed for anything that must persist to
  demo day.
- `mainnet.base.org` is a **public, rate-limited** endpoint. Fine for cached per-asset
  `decimals()` lookups; likely not fine for G2's real payment traffic.

### 2026-09-12 — hosted Postgres is not reachable from this container (egress is 443-only)

Credentials for Supabase and Alchemy arrived. The Supabase connection failed, and the cause
is the environment rather than the credentials:

```
aws-0-us-east-1.pooler.supabase.com:443   -> OPEN
aws-0-us-east-1.pooler.supabase.com:5432  -> TimeoutError
github.com:22                             -> TimeoutError   (control)
github.com:443                            -> OPEN           (control)
```

**This container can only egress on port 443**, so no hosted Postgres is reachable from it,
from any provider — `substreams-sink-sql` needs the native wire protocol on 5432. Separately,
Supabase's direct host `db.<ref>.supabase.co` is IPv6-only (no A record) and this container
has no IPv6; the IPv4 pooler exists but is blocked by the port rule anyway.

**This does not block or weaken G1.** Its exit criterion is live Base rows in a `payments`
table, and the *data* being live is what the Graph tracks require — only the storage location
is local. G1 proceeds against local Postgres; `SUPABASE_DATABASE_URL` is preserved in `.env`
for running the sink from a machine with unrestricted egress when we need persistence for
demo day.

Added `scripts/db-up.sh` — the local server ships stopped and needs `service postgresql start`
after every container start, listens on localhost only, and the unix-socket path fails peer
auth. The script handles all of it idempotently.

Also recorded: passwords in connection URIs must be percent-encoded (`@` -> `%40`), or the
URI parser reads the `@` as the host separator.

### 2026-09-13 — G1 PASSED

The full pipeline runs end to end on live Base data:
compose x402 + erc20-tokens -> in-module `eth_call` for decimals -> normalise -> stores ->
`db_out` -> `substreams-sink-sql` -> Postgres.

```
 payments |  total_usd
----------+-------------
      908 | 5065.559044

payer != facilitator : 905 / 908  (99.7%)
payment_id collisions: 0
vendors (first-seen) : 183
blocks sunk          : 51,234,998 .. 51,235,713
```

The 99.7% independently reproduces G0b's 99.6%, this time through the whole pipeline rather
than a raw stream read.

- **The decimals plan is confirmed working**, not just argued: `decimals: 6` came back for
  USDC via batched `eth_call` and `10000` scaled to `0.01`. This closes the gap left when
  `erc20-tokens` turned out not to carry decimals.
- **`amount_usd` vs `amount_decimal` are separate columns.** Decimals alone do not make a
  value USD, so `amount_usd` is NULL for anything that is not a recognised USD stablecoin and
  `SUM(amount_usd)` stays truthful.
- **Composition is provable:** the packed spkg carries the imported x402 module at hash
  `4aa30170...`, byte-identical to the standalone package — the exact upstream module is
  reused, not copied.
- **Honesty check recorded (NOTES.md §9.1):** Pinax already ships `evm-x402`, a flat 1:1 dump
  of x402 events. We must not claim the category. `papertrail` differs by composing x402 WITH
  erc20-tokens, computing a facilitator allowlist, sourcing decimals, and keeping a vendor
  first-seen store — none of which `evm-x402` does.
- **Two sink mechanics cost a cycle each** and are now documented: stores backfill from
  `initialBlock` (defaulting to 0 made the sink rescan 51M blocks and flush nothing), and
  `--batch-block-flush-interval` defaults to 1000 blocks, which is larger than a short test
  range.
- `payer == facilitator` on 3 rows is a genuine self-relaying agent, not a bug — the one case
  where `tx.from` attribution is accidentally correct, and a risk rule must not flag it.

**Schema is FROZEN** at `papertrail/postgres/schema.sql`. Next: G2.

### 2026-09-13 — G2 built (blocked on funding), G3 built, G4 PASSED

**G2** — 12 Privy agent wallets + 1 facilitator created, each agent with its own policy.
The agent/facilitator split is the substance: the agent signs the EIP-3009 authorization and
the facilitator broadcasts it, so our own payments land with `payer != tx.from`, the same
shape as the 99.7% measured across Base.

Verified the EIP-712 domain against the live contract rather than trusting it — read `name`,
`version` and `DOMAIN_SEPARATOR` from USDC on Base, recomputed the separator from what we
would sign, and they **match**. A wrong name or version yields a signature that looks valid
and fails on-chain, which would have cost real funds to discover.

Blocked only on funding.

**G3** — enricher against the Agent0 subgraph on Base, plus R1/R2/R4. Each finding carries a
`proposed_rule` that is literally the JSON POSTed to Privy, so a human approves the thing
that gets enforced rather than a description of it.

Two honesty decisions recorded: R1 **skips loudly** when the registry has not been checked
instead of reporting "no unregistered vendors", and R4 is marked **advisory** because the
facilitator is not a field of the EIP-3009 message and therefore cannot be denied at signing
time at all.

R1 needs `GRAPH_API_KEY` — the Graph **Market** key used for Substreams is rejected by the
subgraph gateway as "malformed API key". Two Graph products, two credentials.

**G4 PASSED** — `POST /v1/findings/{id}/backtest` returns the required shape, and the first
real result is the useful kind:

```json
"would_block":     { "count": 0, "usd": "0", "tx": [] },
"false_positives": { "count": 1, "detail": [{ "independent_payers": 302 }] }
```

The rule would stop nothing of ours and targets a vendor 302 independent payers use, so the
backtest advises **against** enforcing it. Corrected a real semantic bug found while testing:
the first version reported the vendor's *payers* as false positives, which a rule on our own
wallets cannot block. `blast_radius` now carries that context separately and labelled.

### 2026-09-13 — G6 PASSED

**MCP server** — `spend_summary`, `vendor_risk`, `list_findings`, `backtest_rule`,
`propose_enforcement`, verified end to end over stdio JSON-RPC. Asking it the brief's own
test question returns real, citable data:

```
908 payments | $5,065.56 | 467 payers | 230 vendors | 57 facilitators
905 of 908 have payer != tx.from
```

Every tool cites transaction hashes. A report that says "you spent $X with a risky vendor"
is worthless if a human cannot go and check it.

**Works against any fleet** — fleet membership is a parameter, never a hardcoded list.
Omitting `payers` falls back to the demo fleet; passing a list scopes to those wallets;
passing `[]` means all indexed payers chain-wide. Those last two were collapsed in the first
version, which made "show me everything" silently return the demo fleet's numbers — fixed.

**Console** — single page, no chart library, no theming. Spend table, finding detail, policy
diff, approve. The diff shows the exact JSON appended to the policy, so what a human approves
is what gets enforced.

Two approval guards, both verified firing rather than assumed:
- **409** — cannot approve a finding that has not been backtested. Approving a rule nobody
  has replayed is exactly the mistake this tool exists to prevent.
- **400** — an advisory (R4) finding is refused outright, with the reason.

Rendering the page also caught a real accuracy bug: the attribution line rounded 905/908 up
to "100%". It now reads 99.7% and never rounds up. Overstating our own headline number is the
fastest way to lose a reviewer.

### 2026-09-13 — G5 PASSED, both halves

**Enforcement loop**, rehearsed three times with a fresh vendor each time:

```
[before] agent-01 signing to <vendor>           -> SIGNED
         appended to 12 policies, no rule lost
[after ] agent-01 signing the IDENTICAL payload -> REFUSED (policy_violation)
[ctrl  ] agent-01 signing to a DIFFERENT vendor -> SIGNED
```

The agent is refused **by Privy**, not by our code — which is the entire point. A gate in our
own client is something an agent routes around by not calling it.

**Human quorum**, and it is enforced server-side rather than by our console:

```
[unsigned] -> 401 Missing `privy-authorization-signature` header
[1-of-2]   -> 401 Number of signatures does not match the authorization threshold
[2-of-2]   -> ACCEPTED
```

Implementing this needed the full signing spec, which is not in the API reference: RFC 8785
canonical JSON → SHA-256 → ECDSA P-256 → DER → base64, comma-separated for multi-sig. It was
accepted by the live API on the first attempt. Canonicalization is the sharp edge — a
key-ordering mistake signs different bytes and fails as an opaque 401 that reads like a
credential problem.

**The brief's "version guard" does not exist**, so it is implemented as append + invariant
check: `POST .../rules` adds exactly one rule and cannot clobber a concurrent edit, and the
script then verifies the policy gained one rule and lost none, aborting if anything vanished.

### 2026-09-13 — G3 PASSED with live registry data

`GRAPH_API_KEY` worked on retry — a freshly created Subgraph Studio key needs a few minutes
to propagate, and returns `auth error: API key not found` in the meantime even though it is
valid. Worth knowing: that error does not mean the key is wrong.

Enriched all 230 vendors against the Agent0 / ERC-8004 subgraph on Base:

```
2 registered, 228 NOT in the registry
R1: 228 findings, $5,000.57 exposure
```

**The result recalibrates the rule, and the write-up says so.** 99.1 % of vendors receiving
x402 payments on Base are absent from ERC-8004, so "unregistered" is the norm rather than an
anomaly. Presenting 228 high-severity findings as individually actionable would be precisely
the alarm-fatigue failure that gets security tooling ignored. R1 is meaningful only ranked by
exposure and combined with R2; the backtest is what keeps it honest, since it flags a
widely-used vendor as a likely false positive regardless of registry status.

That ~1 % ERC-8004 adoption among live x402 payees is itself a finding worth reporting, and it
is the reason the project leans on behavioural signals over registry membership.

Funding note: the USDC and ETH were sent to the correct facilitator address but on **Ethereum
mainnet**, not Base (verified: both transactions succeed on Ethereum, neither exists on Base).
The funds are safe — Privy controls the same address on every EVM chain — but G2 needs them on
Base.

### 2026-09-13 — G2 PASSED, and the enforcement fired on its own

Funded on Base, distributed to 6 agents, ran the payment loop. Agents sign EIP-3009
authorizations through Privy; the facilitator broadcasts them.

```
8 settled · 4 refused by policy
8/8 settled payments have payer != tx.from
```

**The result nobody arranged:** agents 03 and 05 were assigned a recipient that happened to be
the vendor blocked during the G5 rehearsal hours earlier. Privy refused their signatures mid-run
with `policy_violation`, while the four agents whose recipients carried no rule paid normally.

A risk finding became a policy rule, a human approved it, and it then silently stopped real
money reaching that vendor — at signing time, so there was nothing to broadcast and nothing to
reverse. That is the entire project working end to end on live funds, unprompted.

All nine gates now pass.

### 2026-09-13 — G7 shipped (Bazantic A/B, run locally)
- Built `bazantic/ab/openapi-mcp-shim.mjs`: generates one MCP tool per operation from
  `api/openapi.json` verbatim — the same transform a Bazantic gateway performs — so both A/B
  arms see byte-identical tools over the same live Postgres ledger.
- Built `bazantic/ab/run-ab.mjs`: same model (`claude-opus-5`), same task, run twice; Recipe
  is the only variable (arm B gets the Recipe `description` as appended system prompt + the
  filled `prompt_template`; arm A gets the bare question).
- Isolation: children run in a temp dir OUTSIDE the repo (else `CLAUDE.md` discovery leaks the
  working agreement — an early run was contaminated this way and was discarded) and with all
  built-in tools denied (verified: both arms' Bash/Read attempts were refused).
- Result recorded in `bazantic/ab-test.md`. Both arms reached the correct "block nothing"
  headline because the OpenAPI descriptions already carry attribution/backtest/unchecked
  facts; the Recipe's measured value is citation discipline (**13 tx hashes vs 0**) and four
  honesty guardrails the spec cannot enforce.
- Note: arm B hit a 429 session limit on its first attempt and was re-run via `AB_ONLY=B`
  (results merged, arm A's good run preserved).
- Bazantic eligibility: account **Kal-MrNobody**, gateway `ulbnrohdjrg6dlid3hgvv6ptzm` active
  and serving 402s, Recipe `agent-spend-audit` published & bound. Honest caveat: the gateway's
  upstream is a placeholder because this container is 443-egress-only (no public host).
