#!/usr/bin/env node
/**
 * G3 step 2 - evaluate risk rules over the ledger and write findings.
 *
 * Every finding carries a proposed_rule that is literally the JSON body POSTed
 * to Privy. A human approves the thing that gets enforced, not a description of
 * it, so there is no translation step where meaning can drift.
 *
 * R2/R4 need only the ledger. R1 needs the registry, so it is SKIPPED WITH A
 * LOUD NOTICE when enrichment has not run, rather than silently reporting
 * "no unregistered vendors" - absence of data is not evidence of safety.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pool } from '../lib/db.mjs';
import { RULES, denyVendorRule, findingId } from '../lib/rules.mjs';

const db = pool();

// "Our fleet" = the payers we control. Without it, R2's "we are >50% of this
// vendor's receipts" has no meaning.
const fleetPath = new URL('../fleet.json', import.meta.url);
const fleet = existsSync(fleetPath) ? JSON.parse(readFileSync(fleetPath, 'utf8')) : null;
const OURS = (fleet?.agents ?? []).map((a) => a.address.toLowerCase());

const FRESH_DAYS = Number(process.env.G3_FRESH_DAYS ?? 30);
const FACILITATOR_FLOOR = Number(process.env.G3_FACILITATOR_FLOOR ?? 5);

async function upsert(f) {
  const rule = { ...f.proposed_rule };
  await db.query(`
    insert into findings (id, rule, severity, subject, subject_kind, summary, detail,
                          evidence_tx, payment_count, exposure_usd, proposed_rule,
                          created_at, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), 'open')
    on conflict (id) do update set
      summary = excluded.summary, detail = excluded.detail,
      evidence_tx = excluded.evidence_tx, payment_count = excluded.payment_count,
      exposure_usd = excluded.exposure_usd, proposed_rule = excluded.proposed_rule
  `, [f.id, f.rule, f.severity, f.subject, f.subject_kind, f.summary, f.detail ?? null,
      f.evidence_tx, f.payment_count, f.exposure_usd ?? null, JSON.stringify(rule)]);
}

let counts = { R1: 0, R2: 0, R4: 0 };

// ---- R1 : vendor absent from the ERC-8004 registry -------------------------
const { rows: [{ n: enriched }] } = await db.query('select count(*)::int n from vendor_registry');
if (enriched === 0) {
  console.log('R1 SKIPPED - vendor_registry is empty. Run scripts/g3-enrich.mjs first.');
  console.log('             (Not reporting "no unregistered vendors": we have not checked.)\n');
} else {
  const { rows } = await db.query(`
    select p.recipient as subject,
           count(*)::int as payment_count,
           sum(p.amount_usd) as exposure_usd,
           (array_agg(p.tx_hash order by p.block_num desc))[1:5] as evidence_tx
    from payments p
    join vendor_registry vr on vr.address = p.recipient
    where vr.registered = false
    group by p.recipient
    order by sum(p.amount_usd) desc nulls last
  `);
  for (const r of rows) {
    const f = {
      id: findingId('R1', r.subject), rule: 'R1', severity: RULES.R1.severity,
      subject: r.subject, subject_kind: 'vendor',
      summary: RULES.R1.describe(r.subject, r),
      detail: 'Not present in the Agent0 / ERC-8004 registry on Base.',
      evidence_tx: r.evidence_tx, payment_count: r.payment_count,
      exposure_usd: r.exposure_usd,
      proposed_rule: denyVendorRule(r.subject, 'R1 unregistered vendor'),
    };
    await upsert(f); counts.R1++;
  }
}

// ---- R2 : fresh vendor, our fleet is >50% of its lifetime receipts ----------
if (OURS.length === 0) {
  console.log('R2 SKIPPED - no fleet.json, so "our share" is undefined.\n');
} else {
  const { rows } = await db.query(`
    with per_vendor as (
      select recipient,
             count(*)::int                                                as total_receipts,
             count(*) filter (where payer = any($1))::int                 as our_receipts,
             sum(amount_usd) filter (where payer = any($1))               as our_usd,
             min(block_num)                                              as first_block,
             (array_agg(tx_hash order by block_num desc)
                filter (where payer = any($1)))[1:5]                     as evidence_tx
      from payments group by recipient
    )
    select pv.*, v.first_seen_timestamp
    from per_vendor pv
    left join vendors v on v.address = pv.recipient
    where pv.our_receipts > 0
      and pv.our_receipts::numeric / pv.total_receipts > 0.5
      and (v.first_seen_timestamp is null
           or v.first_seen_timestamp > now() - ($2 || ' days')::interval)
  `, [OURS, FRESH_DAYS]);
  for (const r of rows) {
    const share = Math.round((r.our_receipts / r.total_receipts) * 100);
    const f = {
      id: findingId('R2', r.recipient), rule: 'R2', severity: RULES.R2.severity,
      subject: r.recipient, subject_kind: 'vendor',
      summary: RULES.R2.describe(r.recipient, { share_pct: share, payment_count: r.our_receipts }),
      detail: `Our fleet sent ${r.our_receipts} of this vendor's ${r.total_receipts} lifetime receipts.`,
      evidence_tx: r.evidence_tx ?? [], payment_count: r.our_receipts,
      exposure_usd: r.our_usd,
      proposed_rule: denyVendorRule(r.recipient, 'R2 fresh vendor, we are the majority'),
    };
    await upsert(f); counts.R2++;
  }
}

// ---- R4 : facilitator outside the computed allowlist ------------------------
// The allowlist is COMPUTED from observed activity - the upstream x402 package
// deliberately applies no facilitator filtering, so this is ours to derive.
if (OURS.length === 0) {
  console.log('R4 SKIPPED - no fleet.json. Without a payer scope this would aggregate');
  console.log('             every payment on the chain and report them as "our" exposure.\n');
} else {
  const { rows } = await db.query(`
    with activity as (
      select facilitator, count(*)::int as relayed from payments group by facilitator
    ),
    ours as (
      select p.facilitator,
             count(*)::int as payment_count,
             sum(p.amount_usd) as exposure_usd,
             (array_agg(p.tx_hash order by p.block_num desc))[1:5] as evidence_tx
      from payments p
      where p.payer = any($1)
      group by p.facilitator
    )
    select o.*, a.relayed
    from ours o join activity a using (facilitator)
    where a.relayed < $2
  `, [OURS, FACILITATOR_FLOOR]);
  for (const r of rows) {
    const f = {
      id: findingId('R4', r.facilitator), rule: 'R4', severity: RULES.R4.severity,
      subject: r.facilitator, subject_kind: 'facilitator',
      summary: RULES.R4.describe(r.facilitator, { payment_count: r.payment_count }),
      detail: `Observed relaying only ${r.relayed} payment(s) chain-wide, below the floor of ${FACILITATOR_FLOOR}.`,
      evidence_tx: r.evidence_tx, payment_count: r.payment_count,
      exposure_usd: r.exposure_usd,
      // A facilitator finding cannot be enforced by a `to` rule - the facilitator
      // never appears in the signed message. Recorded honestly as advisory.
      proposed_rule: {
        _advisory: true,
        _reason: 'R4 unknown facilitator',
        _note: 'The facilitator is NOT a field of the EIP-3009 message, so it cannot be '
             + 'denied at signing time. Enforcement would require constraining which '
             + 'facilitator the agent submits to, in the x402 client.',
      },
    };
    await upsert(f); counts.R4++;
  }
}

const { rows: [tot] } = await db.query('select count(*)::int n from findings');
console.log(`findings written: R1=${counts.R1} R2=${counts.R2} R4=${counts.R4}  (table total ${tot.n})`);
await db.end();
