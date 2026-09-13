#!/usr/bin/env node
/**
 * RedFlag_Trail MCP server.
 *
 * Two constraints shape every tool here:
 *
 *  1. EVERY answer cites transaction hashes. An agent reporting "you spent $X
 *     with a risky vendor" is worthless if a human cannot go check. Each tool
 *     returns evidence hashes alongside its numbers.
 *
 *  2. It works against ANY fleet, not just our demo data. Fleet membership is a
 *     PARAMETER, never a hardcoded list - so pointing this at someone else's
 *     agent wallets works with no code change.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { pool } from '../lib/db.mjs';
import { backtest } from '../lib/backtest.mjs';
import { denyVendorRule, findingId } from '../lib/rules.mjs';

const db = pool();

/** Default fleet is a convenience for the demo only. Any tool accepts an
 *  explicit `payers` list, which always wins.
 *
 *  The three cases are kept DISTINCT on purpose:
 *    payers omitted    -> fall back to the local demo fleet
 *    payers: [...]     -> scope to exactly those wallets (any fleet, no code change)
 *    payers: []        -> explicitly ALL indexed payers, chain-wide
 *  Collapsing the last two would make "show me everything" silently return the
 *  demo fleet's numbers, which is the kind of quiet wrong answer this tool exists
 *  to avoid. */
function defaultFleet() {
  const p = new URL('../fleet.json', import.meta.url);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')).agents.map((a) => a.address.toLowerCase());
}
const resolveFleet = (payers) =>
  (payers === undefined ? defaultFleet() : payers).map((a) => a.toLowerCase());

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

const server = new McpServer({ name: 'redflag-trail', version: '0.1.0' });

// ---------------------------------------------------------------- spend_summary
server.registerTool('spend_summary', {
  title: 'Spend summary',
  description:
    'Summarise x402 spend over a period, attributed to the PAYER decoded from the '
  + 'EIP-3009 authorization rather than the on-chain tx.from (which is the facilitator '
  + 'that relayed it). Returns totals, top vendors, and citable transaction hashes. '
  + 'Pass `payers` to scope to a specific fleet; omit to summarise all indexed spend.',
  inputSchema: {
    since_days: z.number().optional().describe('Look back this many days (default 30).'),
    payers: z.array(z.string()).optional().describe('Agent wallet addresses to scope to.'),
    limit: z.number().optional().describe('Top-N vendors to return (default 10).'),
  },
}, async ({ since_days = 30, payers, limit = 10 }) => {
  const fleet = resolveFleet(payers);
  const { rows: [tot] } = await db.query(`
    select count(*)::int payments,
           coalesce(sum(amount_usd),0) total_usd,
           count(distinct payer)::int payers,
           count(distinct recipient)::int vendors,
           count(distinct facilitator)::int facilitators,
           count(*) filter (where payer <> tx_from)::int payer_ne_txfrom,
           min(block_num) from_block, max(block_num) to_block
    from payments
    where timestamp > now() - ($1||' days')::interval
      and ($2::text[] = '{}' or lower(payer) = any($2))
  `, [since_days, fleet]);

  const { rows: top } = await db.query(`
    select recipient, count(*)::int payments, coalesce(sum(amount_usd),0) usd,
           (array_agg(tx_hash order by block_num desc))[1:3] evidence_tx
    from payments
    where timestamp > now() - ($1||' days')::interval
      and ($2::text[] = '{}' or lower(payer) = any($2))
    group by recipient order by sum(amount_usd) desc nulls last limit $3
  `, [since_days, fleet, limit]);

  return text({
    window_days: since_days,
    scope: fleet.length ? `${fleet.length} payer wallet(s)` : 'ALL indexed payers (chain-wide)',
    ...tot,
    attribution_note:
      `${tot.payer_ne_txfrom} of ${tot.payments} payments have payer != tx.from. `
    + 'Attributing by tx.from would credit these to the relaying facilitator.',
    top_vendors: top,
  });
});

// ----------------------------------------------------------------- vendor_risk
server.registerTool('vendor_risk', {
  title: 'Vendor risk',
  description:
    'Assess one vendor: registry status from the ERC-8004 / Agent0 subgraph, payment '
  + 'history, how concentrated its receipts are on a given fleet, and any open findings. '
  + 'Always returns transaction hashes as evidence.',
  inputSchema: {
    address: z.string().describe('Vendor (recipient) address.'),
    payers: z.array(z.string()).optional().describe('Fleet to measure concentration against.'),
  },
}, async ({ address, payers }) => {
  const addr = address.toLowerCase();
  const fleet = resolveFleet(payers);

  const { rows: reg } = await db.query('select * from vendor_registry where lower(address) = $1', [addr]);
  const { rows: [act] } = await db.query(`
    select count(*)::int payments, coalesce(sum(amount_usd),0) usd,
           count(distinct lower(payer))::int distinct_payers,
           min(block_num) first_block, max(block_num) last_block,
           (array_agg(tx_hash order by block_num desc))[1:5] evidence_tx
    from payments where lower(recipient) = $1
  `, [addr]);
  const { rows: [ours] } = await db.query(`
    select count(*)::int payments, coalesce(sum(amount_usd),0) usd,
           (array_agg(tx_hash order by block_num desc))[1:5] evidence_tx
    from payments where lower(recipient) = $1 and ($2::text[] <> '{}' and lower(payer) = any($2))
  `, [addr, fleet]);
  const { rows: findings } = await db.query(
    'select id, rule, severity, summary, evidence_tx from findings where lower(subject) = $1', [addr]);

  const registry = reg[0]
    ? { checked: true, registered: reg[0].registered, name: reg[0].name, ens: reg[0].ens,
        x402_support: reg[0].x402_support, total_feedback: reg[0].total_feedback,
        avg_feedback: reg[0].avg_feedback }
    : { checked: false,
        note: 'This vendor has not been checked against the registry. NOT the same as "not registered".' };

  const share = act.payments > 0 ? Math.round((ours.payments / act.payments) * 100) : 0;
  return text({
    address,
    registry,
    activity: act,
    our_exposure: { ...ours, share_of_vendor_receipts_pct: share },
    open_findings: findings,
    evidence_tx: act.evidence_tx,
  });
});

// ---------------------------------------------------------------- list_findings
server.registerTool('list_findings', {
  title: 'List findings',
  description:
    'List risk findings, each with the Privy policy rule it proposes and the transaction '
  + 'hashes that evidence it. Optionally filter by rule or status.',
  inputSchema: {
    rule: z.string().optional().describe('R1, R2 or R4.'),
    status: z.string().optional().describe('open | approved | enforced | dismissed'),
  },
}, async ({ rule, status }) => {
  const { rows } = await db.query(`
    select f.id, f.rule, f.severity, f.subject, f.subject_kind, f.summary, f.detail,
           f.evidence_tx, f.payment_count, f.exposure_usd, f.proposed_rule, f.status,
           b.would_block_count, b.would_block_usd, b.false_positive_count
    from findings f
    left join lateral (select * from backtests b2 where b2.finding_id = f.id
                       order by ran_at desc limit 1) b on true
    where ($1::text is null or f.rule = $1) and ($2::text is null or f.status = $2)
    order by case f.severity when 'high' then 0 when 'medium' then 1 else 2 end,
             f.exposure_usd desc nulls last
  `, [rule ?? null, status ?? null]);
  return text({ count: rows.length, findings: rows });
});

// --------------------------------------------------------------- backtest_rule
server.registerTool('backtest_rule', {
  title: 'Backtest a proposed rule',
  description:
    'Replay a proposed DENY rule over indexed history BEFORE it is enforced. Returns '
  + 'would_block {count, usd, tx[]} and false_positives {count, vendors[]}, where a false '
  + 'positive is a targeted vendor that looks legitimate because many independent payers '
  + 'outside the fleet also pay it. Accepts either an existing finding_id or a raw vendor '
  + 'address to test a hypothetical block.',
  inputSchema: {
    finding_id: z.string().optional().describe('Backtest the rule attached to this finding.'),
    vendor: z.string().optional().describe('Or: test blocking this vendor address outright.'),
    payers: z.array(z.string()).optional(),
  },
}, async ({ finding_id, vendor, payers }) => {
  const fleet = resolveFleet(payers);
  let rule, subject;
  if (finding_id) {
    const { rows } = await db.query('select * from findings where id = $1', [finding_id]);
    if (!rows.length) return text({ error: `no finding ${finding_id}` });
    rule = rows[0].proposed_rule; subject = rows[0].subject;
  } else if (vendor) {
    rule = denyVendorRule(vendor, 'ad-hoc backtest'); subject = vendor;
  } else {
    return text({ error: 'pass either finding_id or vendor' });
  }
  const result = await backtest(db, rule, fleet);
  return text({ subject, proposed_rule: rule, ...result });
});

// ---------------------------------------------------------- propose_enforcement
server.registerTool('propose_enforcement', {
  title: 'Propose enforcement',
  description:
    'Produce the exact Privy policy rule that would block a vendor at SIGNING TIME, '
  + 'together with its backtest. This does NOT enforce anything - enforcement requires '
  + 'a human quorum approval in Privy. Returns the rule JSON ready to POST to '
  + '/v1/policies/{policy_id}/rules.',
  inputSchema: {
    vendor: z.string().describe('Vendor address to block.'),
    reason: z.string().optional(),
    payers: z.array(z.string()).optional(),
  },
}, async ({ vendor, reason = 'manual proposal', payers }) => {
  const fleet = resolveFleet(payers);
  const rule = denyVendorRule(vendor, reason);
  const bt = await backtest(db, rule, fleet);
  const { _reason, ...postable } = rule;
  return text({
    vendor,
    finding_id: findingId('MANUAL', vendor),
    proposed_rule: postable,
    how_to_enforce: {
      method: 'POST',
      path: '/v1/policies/{policy_id}/rules',
      note: 'Appends a single rule. Privy is default-deny and DENY beats ALLOW, so this '
          + 'takes effect for every wallet bound to that policy. Requires the key-quorum '
          + 'approval configured on the policy owner.',
    },
    backtest: bt,
    enforced: false,
  });
});

await server.connect(new StdioServerTransport());
