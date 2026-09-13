# Bazantic integration

Account: **Kal-MrNobody** (GitHub) / khushalshadija05@gmail.com

## Gateway

| | |
|---|---|
| Name | RedFlag_Trail Live |
| Slug | `ulbnrohdjrg6dlid3hgvv6ptzm` |
| Status | active |
| Endpoint | `https://ulbnrohdjrg6dlid3hgvv6ptzm.bazgateway.com` |
| MCP | `https://ulbnrohdjrg6dlid3hgvv6ptzm.bazgateway.com/mcp` |
| Spec | `api/openapi.json`, served from the public repo |

A second gateway (`ee2wsojz5belpc7f2ot2etf35a`) was created first in **draft**; its
MCP endpoint 404s because draft gateways are not served. Kept only as a record — the
active one above is the real gateway.

⚠️ **Upstream endpoint.** `--endpoint` must be an https URL the gateway can forward to,
and this project's API cannot be exposed from the build container: its egress is limited
to port 443, and cloudflared requires outbound TCP 7844 (verified — it fails its own
preflight). The gateway therefore points at a placeholder and must be repointed at a real
host before it can proxy live traffic. Everything else — spec parsing, tool generation,
Recipe binding validation — is real and passed server-side.

## Recipe

**`agent-spend-audit`** — published.

It encodes the four things an agent must not get wrong about this service:

1. **Attribute by `payer`, never `tx.from`.** In x402 the agent signs and a facilitator
   broadcasts, so `tx.from` is the facilitator. Measured on Base, they differ on 99.6 % of
   payments — reading `tx.from` credits almost every payment to the wrong party.
2. **Backtest before recommending a block.** A rule blocking nothing is noise; a rule
   targeting a vendor many independent payers use is probably a false positive. The most
   valuable answer is often "do not enforce this".
3. **Cite transaction hashes.** An unverifiable spend or risk claim is worthless.
4. **Never claim enforcement happened.** A proposal is not an enforcement; applying one
   needs a human quorum approval.

It also carries the honesty constraints: every payment is `confidence: "heuristic"`
(reconstructed, not proven settled), a null `amount_usd` is *unpriced* rather than zero, and
a vendor with no registry record is *unchecked* rather than unregistered.

## Reproduce

```bash
baz login
baz gateway add \
  --spec-url https://raw.githubusercontent.com/Kal-MrNobody/RedFlag_Trail/<branch>/api/openapi.json \
  --endpoint <your public API base URL> \
  --name "RedFlag_Trail" --auth-type none --status active --json
baz recipe create bazantic/recipe.json --json
baz recipe publish agent-spend-audit --json
```
