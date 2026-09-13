#!/usr/bin/env node
/**
 * G3 step 1 - enrich every vendor in the ledger against the Agent0 / ERC-8004
 * registry, cached one row per vendor.
 *
 * Cached because the registry is slow-moving: re-querying an unchanged vendor
 * on every run wastes gateway quota and makes runs non-reproducible.
 */
import { pool } from '../lib/db.mjs';
import { lookupByWallets, summarise } from '../lib/agent0.mjs';

const REFRESH_HOURS = Number(process.env.G3_CACHE_HOURS ?? 24);
const db = pool();

const { rows: vendors } = await db.query(`
  select p.recipient as address, count(*)::int as payments
  from payments p
  left join vendor_registry vr
    on vr.address = p.recipient
   and vr.checked_at > now() - ($1 || ' hours')::interval
  where vr.address is null
  group by p.recipient
  order by count(*) desc
`, [REFRESH_HOURS]);

if (vendors.length === 0) {
  console.log('All vendors have a fresh registry entry - nothing to do.');
  await db.end();
  process.exit(0);
}

console.log(`Enriching ${vendors.length} vendor(s) against the Agent0 registry on Base...`);

// The subgraph takes a list, so one round trip per batch rather than per vendor.
const BATCH = 200;
let registered = 0;
for (let i = 0; i < vendors.length; i += BATCH) {
  const slice = vendors.slice(i, i + BATCH);
  const found = await lookupByWallets(slice.map((v) => v.address));

  for (const v of slice) {
    const s = summarise(found.get(v.address.toLowerCase()));
    if (s.registered) registered++;
    await db.query(`
      insert into vendor_registry
        (address, checked_at, registered, agent_id, name, ens, x402_support, active,
         total_feedback, avg_feedback, validations_completed, registry_created_at)
      values ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (address) do update set
        checked_at = excluded.checked_at,
        registered = excluded.registered,
        agent_id = excluded.agent_id,
        name = excluded.name,
        ens = excluded.ens,
        x402_support = excluded.x402_support,
        active = excluded.active,
        total_feedback = excluded.total_feedback,
        avg_feedback = excluded.avg_feedback,
        validations_completed = excluded.validations_completed,
        registry_created_at = excluded.registry_created_at
    `, [v.address, s.registered, s.agent_id ?? null, s.name ?? null, s.ens ?? null,
        s.x402_support ?? null, s.active ?? null, s.total_feedback ?? null,
        s.avg_feedback ?? null, s.validations_completed ?? null, s.created_at ?? null]);
  }
  console.log(`  ${Math.min(i + BATCH, vendors.length)}/${vendors.length}`);
}

console.log(`\nDone. ${registered} registered, ${vendors.length - registered} NOT in the registry.`);
await db.end();
