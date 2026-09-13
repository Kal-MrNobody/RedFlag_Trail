#!/usr/bin/env node
/**
 * G2 step 1 - create the agent fleet.
 *
 * Creates N Privy agent wallets (the PAYERS, which sign EIP-3009 authorizations)
 * plus one facilitator wallet (which BROADCASTS them and therefore pays gas).
 *
 * That split is the point, not an implementation detail: it reproduces the real
 * x402 topology where the on-chain tx.from is the facilitator and the actual
 * spender is only recoverable from the signed authorization. Our own payments
 * therefore land in the ledger with payer != tx.from, exactly like the 99.7% we
 * measured on Base.
 *
 * Idempotent: if fleet.json already exists it is loaded, not overwritten, so
 * re-running never orphans funded wallets.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createAgentPolicy, createWallet } from '../lib/privy.mjs';

const FLEET_PATH = new URL('../fleet.json', import.meta.url).pathname;
const AGENT_COUNT = Number(process.env.G2_AGENTS ?? 12);   // brief asks for 8-12

if (existsSync(FLEET_PATH)) {
  const existing = JSON.parse(readFileSync(FLEET_PATH, 'utf8'));
  console.log(`fleet.json already exists with ${existing.agents.length} agents.`);
  console.log('Refusing to overwrite - delete it first if you really want a new fleet.');
  console.log(`\nfacilitator: ${existing.facilitator.address}`);
  for (const a of existing.agents) console.log(`  ${a.name.padEnd(10)} ${a.address}`);
  process.exit(0);
}

console.log(`Creating ${AGENT_COUNT} agent wallets + 1 facilitator on Base...\n`);

// Facilitator: no signing policy needed - it broadcasts, it does not sign
// authorizations. Left unpoliced deliberately so gas payment cannot be blocked
// by a rule meant for agents.
const facilitatorWallet = await createWallet();
console.log(`facilitator  ${facilitatorWallet.address}  (${facilitatorWallet.id})`);

const agents = [];
// Persist after EVERY wallet. Writing only at the end meant a failure at agent
// 7 of 12 orphaned the already-created wallets and policies, which is exactly
// what this file's idempotency note promises cannot happen.
const persist = () => writeFileSync(FLEET_PATH, JSON.stringify({
  created_at: new Date().toISOString(), chain: 'base-mainnet', chain_id: 8453,
  facilitator: { address: facilitatorWallet.address, wallet_id: facilitatorWallet.id },
  agents,
}, null, 2));
persist();

for (let i = 1; i <= AGENT_COUNT; i++) {
  const name = `agent-${String(i).padStart(2, '0')}`;
  // One policy per wallet - Privy documents a max of 1 policy per wallet, so the
  // policy IS the agent's control surface and G5 appends its DENY rules here.
  const policy = await createAgentPolicy(`RedFlag ${name}`);
  const wallet = await createWallet([policy.id]);
  agents.push({ name, address: wallet.address, wallet_id: wallet.id, policy_id: policy.id });
  persist();
  console.log(`${name}     ${wallet.address}  policy=${policy.id}`);
}

console.log(`\nWrote ${FLEET_PATH} (gitignored - it contains wallet ids).`);
console.log('\nNEXT: fund the facilitator address above with USDC + a little ETH.');
console.log('It distributes USDC to the agents and pays gas for every broadcast.');
