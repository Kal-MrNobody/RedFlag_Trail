#!/usr/bin/env node
/**
 * G2 step 2 - distribute USDC from the facilitator to the agent wallets.
 *
 * Agents must hold the USDC themselves: in EIP-3009 the authorization is signed
 * BY the token holder, so an agent that holds nothing cannot produce a
 * settleable authorization no matter what it signs.
 */
import { readFileSync } from 'node:fs';
import { encodeFunctionData, formatEther } from 'viem';
import { sendTransaction } from '../lib/privy.mjs';
import { client, USDC, ERC20_ABI, usdc, fromUsdc } from '../lib/chain.mjs';

const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'));
const c = client();

const PER_AGENT = process.env.G2_PER_AGENT ?? '0.20';   // USDC per agent
const COUNT = Number(process.env.G2_FUND_COUNT ?? 6);   // how many agents to fund

const facBal = await c.readContract({
  address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [fleet.facilitator.address],
});
const facEth = await c.getBalance({ address: fleet.facilitator.address });
console.log(`facilitator USDC ${fromUsdc(facBal)}  ETH ${formatEther(facEth)}`);

const need = usdc(PER_AGENT) * BigInt(COUNT);
if (facBal < need) {
  console.error(`\nInsufficient USDC: need ${fromUsdc(need)} to fund ${COUNT} agents at ${PER_AGENT} each.`);
  console.error(`Send USDC on Base to ${fleet.facilitator.address}`);
  process.exit(1);
}
if (facEth === 0n) {
  console.error(`\nFacilitator has no ETH for gas. Send a little ETH on Base to ${fleet.facilitator.address}`);
  process.exit(1);
}

const targets = fleet.agents.slice(0, COUNT);
console.log(`\nDistributing ${PER_AGENT} USDC to ${targets.length} agents...\n`);

for (const a of targets) {
  const existing = await c.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [a.address],
  });
  if (existing > 0n) { console.log(`${a.name}  already holds ${fromUsdc(existing)} - skipping`); continue; }

  const data = encodeFunctionData({
    abi: ERC20_ABI, functionName: 'transfer', args: [a.address, usdc(PER_AGENT)],
  });
  const res = await sendTransaction(fleet.facilitator.wallet_id, { to: USDC, data, value: '0x0' });
  const hash = res?.data?.hash ?? res?.hash;
  const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000 });
  // Mined is not the same as succeeded; a reverted transfer moves no USDC.
  if (receipt.status !== 'success') {
    console.error(`${a.name}  -> ${hash} REVERTED - distribution failed, stopping.`);
    process.exit(1);
  }
  console.log(`${a.name}  -> ${hash} ok`);
}
console.log('\nDone. Run `npm run balances` to confirm.');
