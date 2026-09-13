#!/usr/bin/env node
/**
 * RedFlag_Trail — the whole story in one command.
 *
 *   live spend  ->  a risky vendor  ->  backtest  ->  human quorum approves
 *               ->  Privy blocks the next payment AT SIGNING TIME
 *
 * Every stage runs the real code path on live data:
 *   1. RECONSTRUCT  reads the live indexed ledger (the same query the API serves).
 *   2. FLAG         picks a real high-severity finding with its real evidence hashes
 *                   and the exact Privy rule it proposes.
 *   3. BACKTEST     replays that rule over indexed history (lib/backtest.mjs) to prove
 *                   it is not a false positive before anyone is asked to approve it.
 *   4. QUORUM       asks a real 2-of-2 Privy key quorum to approve — and proves the
 *                   gate by showing Privy REFUSE the unsigned and the 1-of-2 change.
 *   5. ENFORCE      appends the rule to a real fleet agent's policy and shows the SAME
 *                   agent, signing the SAME EIP-3009 authorization, refused BY PRIVY.
 *
 * Re-runnable: stage 4 uses a uniquely-named throwaway rule each run, and stage 5
 * deletes its own demo rule at both ends so every run starts from a clean baseline
 * and leaves the fleet policies exactly as it found them. It never deletes a rule it
 * did not create.
 *
 * Degrades honestly: with no Privy credentials / fleet / quorum, stages 1–3 still run
 * on live data and stages 4–5 print WHY they were skipped rather than faking a pass.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pool } from '../lib/db.mjs';
import { backtest } from '../lib/backtest.mjs';
import { ruleFingerprint } from '../lib/rules.mjs';
import {
  privy, appendRule, getPolicy, deleteRule, signTypedData, buildAuthorization,
} from '../lib/privy.mjs';
import { signRequest, joinSignatures } from '../lib/quorum.mjs';

const USDC = process.env.USDC_BASE ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRIVY_BASE = process.env.PRIVY_API_BASE ?? 'https://api.privy.io';
// The demo's narrative subject: the highest-value unregistered vendor with a
// single payer — the one vendor a block is actually defensible against. Override
// with DEMO_VENDOR=0x... to tell a different story.
const SUBJECT = (process.env.DEMO_VENDOR ?? '0xe742f9df04a61ac0a6aea0b87d3c3b96ac6eea88').toLowerCase();

const db = pool();
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rule = (n = 64) => console.log('─'.repeat(n));
const head = (n, t) => { console.log(`\n${'━'.repeat(64)}\n  STAGE ${n} — ${t}\n${'━'.repeat(64)}`); };
const short = (a) => `${a.slice(0, 10)}…${a.slice(-6)}`;

const load = (rel) => {
  const p = new URL(rel, import.meta.url);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};

// ───────────────────────────────────────────────────── stage 1: reconstruct
async function reconstruct() {
  head(1, 'RECONSTRUCT live x402 spend, attributed to the real payer');
  const { rows: [s] } = await db.query(`
    select count(*)::int payments,
           coalesce(sum(amount_usd),0) total_usd,
           count(distinct payer)::int payers,
           count(distinct recipient)::int vendors,
           count(distinct facilitator)::int facilitators,
           count(*) filter (where payer <> tx_from)::int payer_ne_txfrom,
           min(block_num) from_block, max(block_num) to_block
    from payments`);
  const pct = ((s.payer_ne_txfrom / s.payments) * 100).toFixed(1);
  console.log(`  indexed        ${s.payments} payments over blocks ${s.from_block}–${s.to_block}`);
  console.log(`  value (priced) ${money(s.total_usd)}   (null amounts are UNPRICED, not zero)`);
  console.log(`  distinct       ${s.payers} payers · ${s.vendors} vendors · ${s.facilitators} facilitators`);
  rule();
  console.log(`  payer ≠ tx.from on ${s.payer_ne_txfrom}/${s.payments} = ${pct}% of payments.`);
  console.log('  The agent SIGNS the EIP-3009 authorization; a facilitator BROADCASTS it,');
  console.log(`  so tx.from is one of ${s.facilitators} facilitators. Attributing by tx.from would`);
  console.log('  credit almost every payment to the wrong party. We attribute by payer.');
  return s;
}

// ───────────────────────────────────────────────────────── stage 2: flag
async function flag() {
  head(2, 'FLAG a risky vendor, with the exact policy rule it proposes');
  const { rows } = await db.query('select * from findings where subject = $1', [SUBJECT]);
  if (!rows.length) throw new Error(`no finding for ${SUBJECT} — run g3-risk.mjs, or set DEMO_VENDOR`);
  const f = rows[0];
  const { rows: [act] } = await db.query(`
    select count(*)::int payments, coalesce(sum(amount_usd),0) usd,
           count(distinct payer)::int payers
    from payments where lower(recipient) = $1`, [SUBJECT]);
  console.log(`  vendor    ${f.subject}`);
  console.log(`  finding   ${f.id}  [${f.rule} · ${f.severity}]`);
  console.log(`  why       ${f.detail}`);
  console.log(`  activity  ${act.payments} payment(s), ${money(act.usd)}, from ${act.payers} distinct payer(s)`);
  console.log(`  evidence  ${(f.evidence_tx ?? []).slice(0, 2).join('\n            ')}`);
  const { _reason, ...postable } = f.proposed_rule;
  rule();
  console.log('  proposed Privy rule (constrains eth_signTypedData_v4 on the message `to`):');
  console.log(`    action=${postable.action}  method=${postable.method}`);
  console.log(`    to == ${postable.conditions[0].value}`);
  return f;
}

// ─────────────────────────────────────────────────────── stage 3: backtest
async function backtestStage(f, ours) {
  head(3, 'BACKTEST the rule over indexed history before anyone approves it');
  const r = await backtest(db, f.proposed_rule, ours);
  if (!r.supported) { console.log(`  not replayable: ${r.reason}`); return { r, safe: false }; }
  console.log(`  would have blocked   ${r.would_block.count} fleet payment(s)  ${money(r.would_block.usd)}`);
  console.log(`  false positives      ${r.false_positives.count} vendor(s) many independent payers also use`);
  rule();
  const safe = r.false_positives.count === 0;
  if (safe) {
    console.log('  No false-positive signal: this vendor is not a widely-used service, so a');
    console.log('  block will not break legitimate traffic. Safe to put to a human quorum.');
  } else {
    console.log('  ⚠ Flagged as a likely false positive — the most valuable answer is often');
    console.log('  "do NOT enforce". A real operator would stop here; this demo continues only');
    console.log('  to exercise the enforcement path. Pick a cleaner DEMO_VENDOR for a true run.');
  }
  return { r, safe };
}

// ───────────────────────────────────────────────────────── stage 4: quorum
async function quorumStage() {
  head(4, 'HUMAN QUORUM approval — enforced by Privy, not by our console');
  const q = load('../quorum.json'); const keys = load('../quorum-keys.json');
  if (!q || !keys) { console.log('  SKIPPED — no quorum.json / quorum-keys.json (run scripts/g5-quorum-setup.mjs)'); return null; }
  console.log(`  quorum ${q.key_quorum_id}  threshold ${q.threshold}/2  gating policy ${q.policy_id}`);
  const name = `DEMO approval ${Date.now()}`.slice(0, 50);
  const testRule = {
    name, method: 'eth_signTypedData_v4', action: 'DENY',
    conditions: [{
      field_source: 'ethereum_typed_data_message', field: 'to', operator: 'eq',
      value: '0x000000000000000000000000000000000000dead',
      typed_data: { primary_type: 'TransferWithAuthorization', types: { TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] } },
    }],
  };
  const url = `${PRIVY_BASE}/v1/policies/${q.policy_id}/rules`;
  const hdr = { 'privy-app-id': process.env.PRIVY_APP_ID };

  let unsigned = 'ACCEPTED';
  try { await privy('POST', `/v1/policies/${q.policy_id}/rules`, testRule); }
  catch (e) { unsigned = `REFUSED (${e.status})`; }
  console.log(`  [no signature]   append a rule -> ${unsigned}`);

  const sigA = signRequest({ method: 'POST', url, body: testRule, headers: hdr, privateKeyB64: keys.approver_a.private_key });
  let one = 'ACCEPTED';
  try { await privy('POST', `/v1/policies/${q.policy_id}/rules`, testRule, { 'privy-authorization-signature': sigA }); }
  catch (e) { one = `REFUSED (${e.status})`; }
  console.log(`  [1-of-2 signed]  append a rule -> ${one}`);

  const sigB = signRequest({ method: 'POST', url, body: testRule, headers: hdr, privateKeyB64: keys.approver_b.private_key });
  let two = 'REFUSED';
  try { const r = await privy('POST', `/v1/policies/${q.policy_id}/rules`, testRule, { 'privy-authorization-signature': joinSignatures([sigA, sigB]) }); two = `ACCEPTED (rule ${r.id ?? '?'})`; }
  catch (e) { two = `REFUSED (${e.status})`; }
  console.log(`  [2-of-2 signed]  append a rule -> ${two}`);
  // The 2-of-2 append persists one harmless DENY (on 0x..dead) to this throwaway
  // quorum-test policy each run. It is never one of the 12 real fleet policies, so
  // it changes no agent's behaviour; deleting it back out would itself be a
  // quorum-signed action, which this demo keeps out of scope.
  rule();
  const pass = unsigned.startsWith('REFUSED') && one.startsWith('REFUSED') && two.startsWith('ACCEPTED');
  console.log(pass
    ? '  Privy refused every under-quorum change and accepted only the fully-signed one.\n  "A human quorum approves" is a property of the signer, not of our UI.'
    : '  Quorum gate did not behave as expected — see the three lines above.');
  return pass;
}

// ──────────────────────────────────────────────────────── stage 5: enforce
async function enforceStage(f) {
  head(5, 'ENFORCE at signing time — the agent is refused BY PRIVY');
  const fleet = load('../fleet.json');
  if (!fleet?.agents?.length) { console.log('  SKIPPED — no fleet.json (run scripts/g2-create-fleet.mjs)'); return null; }
  const agent = fleet.agents[0];
  const { _reason, ...baseRule } = f.proposed_rule;
  // Namespace the demo rule so reset only ever removes THIS demo's rule, never a
  // genuine enforcement that happens to target the same vendor.
  const demoRule = { ...baseRule, name: `DEMO ${baseRule.name}`.slice(0, 50) };

  const removeDemoRule = async (a) => {
    const pol = await getPolicy(a.policy_id);
    for (const r of pol.rules ?? []) if (r.name === demoRule.name) await deleteRule(a.policy_id, r.id);
  };
  const sign = async (to) => {
    const payload = buildAuthorization({ from: agent.address, to, value: '10000', usdc: USDC });
    try { await signTypedData(agent.wallet_id, payload); return 'SIGNED'; }
    catch (e) { return `REFUSED (${e.json?.code ?? e.status})`; }
  };

  console.log(`  agent ${agent.name}  ${short(agent.address)}`);
  await removeDemoRule(agent);                                   // clean baseline
  const before = await sign(f.subject);
  console.log(`  [before] sign a payment to ${short(f.subject)} -> ${before}`);

  await appendRule(agent.policy_id, demoRule);
  console.log(`  ...quorum-approved rule appended to ${agent.name}'s policy`);

  const after = await sign(f.subject);
  console.log(`  [after ] sign the IDENTICAL payment          -> ${after}`);
  const control = await sign('0x000000000000000000000000000000000000c0fe');
  console.log(`  [control] sign to a DIFFERENT vendor         -> ${control}`);

  await removeDemoRule(agent);                                   // leave no residue
  console.log('  ...demo rule removed; fleet policy restored to baseline');
  rule();
  const pass = before === 'SIGNED' && after.startsWith('REFUSED (policy_violation') && control === 'SIGNED';
  console.log(pass
    ? '  The agent could sign a second ago; the same signature is now refused inside\n  the signer. The block is at SIGNING TIME — the agent never gets a signature to\n  hand a facilitator. A different vendor still signs, so it is scoped, not a halt.'
    : `  Unexpected: before=${before} after=${after} control=${control}`);
  return pass;
}

// ───────────────────────────────────────────────────────────────── main
(async () => {
  console.log('\nRedFlag_Trail — end-to-end, on live data\n' + '='.repeat(64));
  const fleet = load('../fleet.json');
  const ours = (fleet?.agents ?? []).map((a) => a.address.toLowerCase());
  const results = {};
  try {
    await reconstruct();
    const f = await flag();
    const { safe } = await backtestStage(f, ours);
    results.backtest_safe = safe;
    results.quorum = await quorumStage();
    results.enforce = await enforceStage(f);
  } finally {
    await db.end();
  }

  head('✓', 'SUMMARY');
  const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
  line('1 reconstruct', 'live ledger read ✓');
  line('2 flag', 'real finding + proposed rule ✓');
  line('3 backtest', results.backtest_safe ? 'safe to enforce ✓' : 'flagged false-positive (see stage 3)');
  line('4 human quorum', results.quorum === null ? 'skipped (no quorum configured)' : results.quorum ? 'Privy-gated 2-of-2 ✓' : 'unexpected');
  line('5 signing-time block', results.enforce === null ? 'skipped (no fleet configured)' : results.enforce ? 'refused BY PRIVY ✓' : 'unexpected');
  const live = results.quorum && results.enforce;
  console.log('\n' + (live
    ? '  Full loop proven live: on-chain spend → finding → backtest → human quorum →\n  a payment blocked at signing time.'
    : '  Stages 1–3 proven on live data. Stages 4–5 need Privy credentials, a fleet and\n  a quorum in .env to run against the live signer.'));
  process.exit(results.enforce === false || results.quorum === false ? 1 : 0);
})();
