#!/usr/bin/env node
/**
 * RedFlag_Trail — LIVE enforcement demo, for a stage.
 *
 * Where e2e-demo.mjs plays the whole story automatically, this one puts the
 * human in the loop in real time. An agent keeps trying to pay a risky vendor;
 * you approve the block with a keypress; the agent's very next attempt is
 * refused BY PRIVY, in front of the audience. Every attempt is a real
 * eth_signTypedData_v4 call — nothing is faked, and no funds are needed
 * (signing costs no gas).
 *
 *   [a]  a human quorum approves the block  → the rule is enforced live
 *   [r]  lift the block again               → the agent is authorized again
 *   [q]  quit (removes the demo rule, restores the policy)
 *
 * Set LIVE_AUTO=1 to run the sequence hands-free (authorize → block → lift)
 * for a screen recording or a quick self-check.
 */
import { readFileSync, existsSync } from 'node:fs';
import { signTypedData, appendRule, getPolicy, deleteRule, buildAuthorization } from '../lib/privy.mjs';
import { denyVendorRule } from '../lib/rules.mjs';

const USDC = process.env.USDC_BASE ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VENDOR = (process.env.DEMO_VENDOR ?? '0xe742f9df04a61ac0a6aea0b87d3c3b96ac6eea88').toLowerCase();
const INTERVAL = Number(process.env.LIVE_INTERVAL_MS ?? 2500);
const AMOUNT_USDC = process.env.DEMO_AMOUNT ?? '250';

const fleetPath = new URL('../fleet.json', import.meta.url);
if (!existsSync(fleetPath)) {
  console.error('No fleet.json — run: node --env-file=.env scripts/g2-create-fleet.mjs');
  process.exit(1);
}
const agent = JSON.parse(readFileSync(fleetPath, 'utf8')).agents[0];

// ANSI helpers
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const green = (s) => c('32', s), red = (s) => c('31;1', s), dim = (s) => c('90', s);
const bold = (s) => c('1', s), amber = (s) => c('33', s), cyan = (s) => c('36', s);

// The rule a human would approve. Namespaced so reset/cleanup only ever touches
// THIS demo's rule, never a genuine enforcement.
const { _reason, ...base } = denyVendorRule(VENDOR, 'live demo');
const rule = { ...base, name: `DEMO LIVE ${base.name}`.slice(0, 50) };
const short = (a) => `${a.slice(0, 10)}…${a.slice(-6)}`;

let enforced = false, attempts = 0, blocked = 0, busy = false, quitting = false;

async function removeDemoRule() {
  const pol = await getPolicy(agent.policy_id);
  for (const r of pol.rules ?? []) if (r.name === rule.name) await deleteRule(agent.policy_id, r.id);
}

async function attempt() {
  if (busy || quitting) return;
  busy = true;
  attempts++;
  const payload = buildAuthorization({ from: agent.address, to: VENDOR, value: String(Number(AMOUNT_USDC) * 1e6), usdc: USDC });
  const t = new Date().toLocaleTimeString();
  try {
    await signTypedData(agent.wallet_id, payload);
    console.log(`${dim(t)}  ${agent.name} → pay ${short(VENDOR)} $${AMOUNT_USDC}   ${green('✓ AUTHORIZED')}  ${dim('(signature issued)')}`);
  } catch (e) {
    blocked++;
    const code = e.json?.code ?? e.status;
    console.log(`${dim(t)}  ${agent.name} → pay ${short(VENDOR)} $${AMOUNT_USDC}   ${red('✗ BLOCKED')}  ${dim(`by Privy (${code})`)}`);
  }
  busy = false;
}

async function approve() {
  if (enforced) return;
  console.log('\n' + amber('  ┌─ 🔒 HUMAN QUORUM APPROVED THE BLOCK ───────────────────────'));
  console.log(amber('  │  appending the DENY rule to ' + agent.name + "'s Privy policy…"));
  await appendRule(agent.policy_id, rule);
  enforced = true;
  console.log(amber('  └─ enforced. The next signature request will be refused live.') + '\n');
}

async function lift() {
  if (!enforced) return;
  console.log('\n' + cyan('  ↩ block lifted — the rule is removed, agent authorized again.') + '\n');
  await removeDemoRule();
  enforced = false;
}

async function cleanup() {
  quitting = true;
  try { await removeDemoRule(); } catch { /* best effort */ }
}

function banner() {
  console.log(bold('\nRedFlag_Trail — live enforcement\n') + '='.repeat(60));
  console.log(`  agent   ${agent.name}  ${short(agent.address)}`);
  console.log(`  vendor  ${VENDOR}  ${dim('(flagged: unregistered, single payer)')}`);
  console.log(dim('  Each line below is a REAL eth_signTypedData_v4 call to Privy.\n'));
  console.log(`  ${bold('[a]')} approve the block   ${bold('[r]')} lift it   ${bold('[q]')} quit\n`);
}

// ---- run ------------------------------------------------------------------
await removeDemoRule().catch(() => {});   // clean baseline: start authorized
banner();

if (process.env.LIVE_AUTO) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) { await attempt(); await wait(600); }
  await approve();
  for (let i = 0; i < 3; i++) { await attempt(); await wait(600); }
  await lift();
  for (let i = 0; i < 2; i++) { await attempt(); await wait(600); }
  await cleanup();
  console.log(dim(`\n${attempts} attempts, ${blocked} blocked. Done.`));
  process.exit(0);
}

const timer = setInterval(attempt, INTERVAL);
attempt();

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (key) => {
  if (key === 'a') await approve();
  else if (key === 'r') await lift();
  else if (key === 'q' || key === '') {
    clearInterval(timer);
    console.log(dim('\ncleaning up…'));
    await cleanup();
    console.log(dim(`${attempts} attempts, ${blocked} blocked. Fleet policy restored.`));
    process.exit(0);
  }
});
