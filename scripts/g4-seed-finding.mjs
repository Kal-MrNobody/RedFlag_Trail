#!/usr/bin/env node
/**
 * Create one finding from a REAL vendor in the live ledger, so the backtest
 * path can be exercised end to end before G2 funding and the registry key land.
 *
 * The vendor, its payments and the evidence hashes are all real indexed data.
 * Only the TRIGGER is manual: R1 would normally raise this after the enricher
 * confirms the vendor is absent from the registry. Labelled as such in the
 * finding so it is never mistaken for a genuine registry result.
 */
import { pool } from '../lib/db.mjs';
import { denyVendorRule, findingId } from '../lib/rules.mjs';

const db = pool();
const { rows } = await db.query(`
  select recipient, count(*)::int payments, coalesce(sum(amount_usd),0) usd,
         (array_agg(tx_hash order by block_num desc))[1:5] tx
  from payments group by recipient order by count(*) desc limit 1
`);
if (!rows.length) { console.error('no payments in the ledger'); process.exit(1); }
const v = rows[0];
const id = findingId('R1', v.recipient);

await db.query(`
  insert into findings (id, rule, severity, subject, subject_kind, summary, detail,
                        evidence_tx, payment_count, exposure_usd, proposed_rule, created_at, status)
  values ($1,'R1','high',$2,'vendor',$3,$4,$5,$6,$7,$8, now(), 'open')
  on conflict (id) do update set
    summary=excluded.summary, detail=excluded.detail, evidence_tx=excluded.evidence_tx,
    payment_count=excluded.payment_count, exposure_usd=excluded.exposure_usd,
    proposed_rule=excluded.proposed_rule
`, [id, v.recipient,
    `${v.recipient} received ${v.payments} payment(s) totalling ${v.usd} USD.`,
    'BACKTEST FIXTURE - trigger is manual, not a registry result. The vendor, its '
    + 'payments and the evidence hashes are real indexed data.',
    v.tx, v.payments, v.usd,
    JSON.stringify(denyVendorRule(v.recipient, 'R1 unregistered vendor (fixture)'))]);

console.log(`seeded finding ${id}`);
console.log(`  vendor   ${v.recipient}`);
console.log(`  payments ${v.payments}  usd ${v.usd}`);
await db.end();
