#!/usr/bin/env node
/** G2 - show funding status for the fleet. Run this to check whether the
 *  facilitator has been funded and how much USDC each agent holds. */
import { readFileSync } from 'node:fs';
import { formatEther } from 'viem';
import { client, USDC, ERC20_ABI, fromUsdc } from '../lib/chain.mjs';

const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'));
const c = client();

const read = async (address) => {
  const [eth, bal] = await Promise.all([
    c.getBalance({ address }),
    c.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
  ]);
  return { eth, bal };
};

const f = await read(fleet.facilitator.address);
console.log(`facilitator ${fleet.facilitator.address}`);
console.log(`   ETH  ${formatEther(f.eth)}`);
console.log(`   USDC ${fromUsdc(f.bal)}\n`);

let totalUsdc = 0n, funded = 0;
for (const a of fleet.agents) {
  const { eth, bal } = await read(a.address);
  totalUsdc += bal;
  if (bal > 0n) funded++;
  console.log(`${a.name}  ${a.address}  USDC ${fromUsdc(bal).padStart(10)}  ETH ${formatEther(eth)}`);
}
console.log(`\nagents funded: ${funded}/${fleet.agents.length}   agent USDC total: ${fromUsdc(totalUsdc)}`);

const ready = f.eth > 0n && (f.bal > 0n || totalUsdc > 0n);
console.log(ready ? '\nREADY - funding detected.' : '\nNOT FUNDED YET - send USDC + ETH to the facilitator address above.');
