#!/usr/bin/env node
/**
 * G5 - the enforcement loop.
 *
 * Takes an APPROVED finding and appends its proposed_rule to every fleet agent's
 * policy, then proves the loop closed: the same agent signing the SAME x402
 * authorization is now refused BY PRIVY, not by our code.
 *
 * That distinction is the whole point. A gate in our own client is something an
 * agent can route around by not calling it. A Privy policy refusal happens
 * inside the signer, so the agent never obtains a signature to hand to a
 * facilitator at all.
 *
 * On the brief's "version guard": Privy has NO version or ETag parameter
 * (NOTES.md 1.5). PATCHing the whole rules array genuinely can clobber a
 * concurrent edit, so we use POST .../rules, which APPENDS a single rule and
 * sidesteps the race entirely. We still verify before/after that no pre-existing
 * rule vanished - that is the honest equivalent of the guard the brief asked for.
 */
import { readFileSync } from 'node:fs';
import { pool } from '../lib/db.mjs';
import { privy, appendRule, getPolicy, signTypedData, buildAuthorization } from '../lib/privy.mjs';

const USDC = process.env.USDC_BASE ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const db = pool();
const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'));

const findingId = process.argv[2];
if (!findingId) {
  const { rows } = await db.query("select id, rule, subject, status from findings order by created_at desc");
  console.log('usage: node --env-file=.env scripts/g5-enforce.mjs <finding_id>\n\nfindings:');
  for (const r of rows) console.log(`  ${r.status.padEnd(9)} ${r.id}  (${r.rule} ${r.subject})`);
  process.exit(1);
}

const { rows } = await db.query('select * from findings where id = $1', [findingId]);
if (!rows.length) { console.error(`no finding ${findingId}`); process.exit(1); }
const finding = rows[0];

if (finding.status !== 'approved') {
  console.error(`Finding is "${finding.status}", not "approved".`);
  console.error('Enforcement requires human approval first - that is the point of the loop.');
  process.exit(1);
}
if (finding.proposed_rule?._advisory) {
  console.error('Advisory finding cannot be enforced at signing time.');
  process.exit(1);
}

const { _reason, ...rule } = finding.proposed_rule;
const vendor = finding.subject;
console.log(`Enforcing ${finding.id}\n  vendor ${vendor}\n  rule   ${rule.name}\n`);

// ---- 1. BEFORE: prove the agent can currently sign to this vendor -----------
const agent = fleet.agents[0];
const payload = buildAuthorization({ from: agent.address, to: vendor, value: '10000', usdc: USDC });

let before = 'REFUSED';
try { await signTypedData(agent.wallet_id, payload); before = 'SIGNED'; }
catch (e) { before = `REFUSED (${e.json?.code ?? e.status})`; }
console.log(`[before] ${agent.name} signing to ${vendor.slice(0, 10)}... -> ${before}`);

// ---- 2. Append the rule to every agent policy, with a before/after check ----
let appended = 0, skipped = 0;
for (const a of fleet.agents) {
  const prior = await getPolicy(a.policy_id);
  const priorIds = new Set((prior.rules ?? []).map((r) => r.id));

  // Idempotent: an identical rule already present is not an error.
  if ((prior.rules ?? []).some((r) => r.name === rule.name && r.action === 'DENY')) {
    skipped++; continue;
  }

  await appendRule(a.policy_id, rule);

  // The guard: append must ADD exactly one rule and remove none.
  const after = await getPolicy(a.policy_id);
  const afterIds = new Set((after.rules ?? []).map((r) => r.id));
  const lost = [...priorIds].filter((id) => !afterIds.has(id));
  if (lost.length) {
    console.error(`\nFAIL: appending to ${a.policy_id} LOST pre-existing rule(s): ${lost.join(', ')}`);
    console.error('Something modified this policy concurrently. Stopping before more damage.');
    process.exit(1);
  }
  if (afterIds.size !== priorIds.size + 1) {
    console.error(`\nFAIL: expected ${priorIds.size + 1} rules on ${a.policy_id}, found ${afterIds.size}.`);
    process.exit(1);
  }
  appended++;
}
console.log(`\nappended to ${appended} policies (${skipped} already had it), no pre-existing rule lost`);

// ---- 3. AFTER: the SAME agent, the SAME payload, must now be REFUSED --------
let after = 'SIGNED', code = null;
try { await signTypedData(agent.wallet_id, payload); }
catch (e) { after = 'REFUSED'; code = e.json?.code ?? e.status; }
console.log(`[after ] ${agent.name} signing the IDENTICAL payload -> ${after}${code ? ` (${code})` : ''}`);

// ---- 4. Control: a DIFFERENT vendor must still sign ------------------------
const other = '0x000000000000000000000000000000000000c0fe';
const control = buildAuthorization({ from: agent.address, to: other, value: '10000', usdc: USDC });
let ctl = 'SIGNED', ctlCode = null;
try { await signTypedData(agent.wallet_id, control); }
catch (e) { ctl = 'REFUSED'; ctlCode = e.json?.code ?? e.status; }
console.log(`[ctrl  ] ${agent.name} signing to a DIFFERENT vendor -> ${ctl}${ctlCode ? ` (${ctlCode})` : ''}`);

console.log('\n' + '='.repeat(64));
const pass = before === 'SIGNED' && after === 'REFUSED' && code === 'policy_violation' && ctl === 'SIGNED';

// Only record "enforced" once the verdict actually holds. Marking it before the
// check meant a FAILED enforcement - where the agent demonstrably could still
// sign - was stored as enforced, which is the worst possible lie for this table.
await db.query('update findings set status=$2 where id=$1',
               [findingId, pass ? 'enforced' : 'approved']);

if (pass) {
  console.log('G5 PASS - the agent signed before, is REFUSED BY PRIVY after, and a');
  console.log('different vendor still signs. Enforcement is at signing time, in the');
  console.log('signer, not in our client.');
  process.exit(0);
}
console.log('G5 FAIL');
console.log(`  before=${before} after=${after} code=${code} control=${ctl}`);
if (after === 'REFUSED' && code !== 'policy_violation') {
  console.log('  The refusal was NOT a policy violation, so it proves nothing about enforcement.');
}
process.exit(1);
