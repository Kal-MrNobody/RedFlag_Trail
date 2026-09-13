#!/usr/bin/env node
/**
 * G2 step 3 - make REAL x402 payments on Base.
 *
 * The agent SIGNS an EIP-3009 authorization through Privy; the facilitator
 * BROADCASTS it by calling USDC.transferWithAuthorization. That is the actual
 * x402 topology, which is why our own payments land in the ledger with
 * payer != tx.from - the same shape as the 99.7% measured across Base.
 *
 * Some payments deliberately go to a FRESH address we control and that no
 * registry has ever seen. That is the planted vendor G3's R1 rule must catch.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signTypedData, sendTransaction, buildAuthorization } from '../lib/privy.mjs';
import { client, USDC, ERC20_ABI, EIP3009_ABI, usdc, fromUsdc, splitSignature } from '../lib/chain.mjs';

const fleetPath = new URL('../fleet.json', import.meta.url);
const fleet = JSON.parse(readFileSync(fleetPath, 'utf8'));
const c = client();

// A vendor address nobody has ever seen. Generated once and persisted so the
// planted-vendor finding is reproducible across runs.
const plantedPath = new URL('../planted-vendor.json', import.meta.url);
let planted;
if (existsSync(plantedPath)) {
  planted = JSON.parse(readFileSync(plantedPath, 'utf8'));
} else {
  const pk = generatePrivateKey();
  planted = { address: privateKeyToAccount(pk).address, private_key: pk,
              note: 'Fresh unregistered vendor for R1. Never seen by any registry.' };
  writeFileSync(plantedPath, JSON.stringify(planted, null, 2));
  console.log(`Generated planted vendor ${planted.address}\n`);
}

const AMOUNT = process.env.G2_AMOUNT ?? '0.01';
const ROUNDS = Number(process.env.G2_ROUNDS ?? 3);

// Known-good vendors observed receiving real x402 traffic on Base, so the
// ledger contains a mix rather than only our planted address.
const REAL_VENDORS = [
  '0xcc1984e79726e7a0ae2b9df2ac9e79fb4983930e',
  '0x9fb365e4e9385e2a39febad70368267e6f571d9a',
];

async function pay(agent, to, label) {
  const bal = await c.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [agent.address],
  });
  if (bal < usdc(AMOUNT)) { console.log(`  ${agent.name} has ${fromUsdc(bal)} USDC - skipping`); return null; }

  // 1. The AGENT signs. Privy enforces its policy here, at signing time.
  const authorization = buildAuthorization({
    from: agent.address, to, value: usdc(AMOUNT).toString(), usdc: USDC,
  });
  let signed;
  try {
    signed = await signTypedData(agent.wallet_id, authorization);
  } catch (e) {
    // A policy_violation here is the enforcement working, not a failure.
    console.log(`  ${agent.name} -> ${label}: REFUSED BY POLICY (${e.json?.code ?? e.status})`);
    return { refused: true, agent: agent.name, to, reason: e.json?.error };
  }

  const sig = signed?.data?.signature ?? signed?.signature;
  const { v, r, s } = splitSignature(sig);
  const m = authorization.message;

  // 2. The FACILITATOR broadcasts. tx.from will be the facilitator, never the payer.
  const data = encodeFunctionData({
    abi: EIP3009_ABI, functionName: 'transferWithAuthorization',
    args: [m.from, m.to, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce, v, r, s],
  });
  const res = await sendTransaction(fleet.facilitator.wallet_id, { to: USDC, data, value: '0x0' });
  const hash = res?.data?.hash ?? res?.hash;
  const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
  // A mined transaction is not a successful one. A reverted
  // transferWithAuthorization emits no payment, so counting it as settled would
  // put a payment in our records that never happened on chain.
  const reverted = receipt.status !== 'success';
  console.log(`  ${agent.name} -> ${label}  ${fromUsdc(usdc(AMOUNT))} USDC  ${hash}` +
              `  [${receipt.status}${reverted ? ' - REVERTED, not counted' : ''}]`);
  return { hash, agent: agent.name, payer: agent.address, to, label,
           status: receipt.status, settled: !reverted };
}

const results = [];
console.log(`Paying ${AMOUNT} USDC per call, ${ROUNDS} rounds.`);
console.log(`planted vendor: ${planted.address}\n`);

for (let round = 1; round <= ROUNDS; round++) {
  console.log(`round ${round}:`);
  for (const [i, agent] of fleet.agents.entries()) {
    // Send a meaningful share to the planted vendor so R2 (we are >50% of its
    // lifetime receipts) has something to fire on.
    const toPlanted = i % 3 === 0;
    const to = toPlanted ? planted.address : REAL_VENDORS[i % REAL_VENDORS.length];
    const r = await pay(agent, to, toPlanted ? 'PLANTED' : 'known');
    if (r) results.push(r);
  }
}

writeFileSync(new URL('../g2-payments.json', import.meta.url), JSON.stringify(results, null, 2));
const settled = results.filter((r) => r.settled);
const reverted = results.filter((r) => r.hash && !r.settled);
const refused = results.filter((r) => r.refused);
console.log(`\n${settled.length} payments settled` +
            (reverted.length ? `, ${reverted.length} REVERTED` : '') +
            (refused.length ? `, ${refused.length} refused by policy` : '') +
            '. Written to g2-payments.json');
console.log('These should now appear in the payments table via the live pipeline.');
