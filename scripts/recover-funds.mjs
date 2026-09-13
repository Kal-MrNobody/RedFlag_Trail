#!/usr/bin/env node
/**
 * Return funds that were sent to the facilitator on the WRONG CHAIN.
 *
 * A Privy wallet is the same address on every EVM chain and Privy holds the key,
 * so funds sent to it on Ethereum are recoverable - they are simply not where
 * the x402 pipeline looks. This sweeps them back to a destination you control.
 *
 * Dry run by default. Pass --execute to actually send.
 *
 *   node --env-file=.env scripts/recover-funds.mjs <destination> [--execute]
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, encodeFunctionData, formatEther, formatUnits, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { sendTransaction } from '../lib/privy.mjs';

const DEST_RAW = process.argv[2];
const EXECUTE = process.argv.includes('--execute');
if (!DEST_RAW) { console.error('usage: recover-funds.mjs <destination> [--execute]'); process.exit(1); }

let DEST;
try { DEST = getAddress(DEST_RAW); }
catch { console.error(`Not a valid address: ${DEST_RAW}`); process.exit(1); }

const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ERC20 = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const fleet = JSON.parse(readFileSync(new URL('../fleet.json', import.meta.url), 'utf8'));
const FROM = fleet.facilitator.address;
const WALLET_ID = fleet.facilitator.wallet_id;
const CAIP2 = 'eip155:1';   // Ethereum mainnet

const c = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') });

const [eth, usdc, gasPrice] = await Promise.all([
  c.getBalance({ address: FROM }),
  c.readContract({ address: USDC_ETHEREUM, abi: ERC20, functionName: 'balanceOf', args: [FROM] }),
  c.getGasPrice(),
]);

// Headroom on gas price: it can move between quoting and inclusion, and an
// underpriced transaction that never mines strands the funds again.
const gp = (gasPrice * 300n) / 100n;
const USDC_GAS = 100_000n;   // generous for an ERC-20 transfer
const ETH_GAS = 21_000n;
const usdcCost = USDC_GAS * gp;
const ethCost = ETH_GAS * gp;

console.log(`from        ${FROM}   (facilitator, Ethereum mainnet)`);
console.log(`to          ${DEST}`);
console.log(`ETH         ${formatEther(eth)}`);
console.log(`USDC        ${formatUnits(usdc, 6)}`);
console.log(`gas price   ${Number(gasPrice) / 1e9} gwei (sending at 3x = ${Number(gp) / 1e9} gwei)`);

if (usdc > 0n && eth < usdcCost + ethCost) {
  console.error(`\nNot enough ETH for gas: need ~${formatEther(usdcCost + ethCost)}, have ${formatEther(eth)}`);
  process.exit(1);
}

// Sweep ETH last, minus the gas its own transfer costs. Sending the full
// balance would leave nothing to pay for the send itself.
const ethToSend = eth > (usdcCost + ethCost) ? eth - usdcCost - ethCost : 0n;

console.log(`\nplan:`);
if (usdc > 0n) console.log(`  1. transfer ${formatUnits(usdc, 6)} USDC -> ${DEST}`);
if (ethToSend > 0n) console.log(`  2. send ${formatEther(ethToSend)} ETH -> ${DEST}  (retaining gas)`);

if (!EXECUTE) {
  console.log('\nDRY RUN. Re-run with --execute to send.');
  process.exit(0);
}

if (usdc > 0n) {
  console.log('\n[1/2] sending USDC...');
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [DEST, usdc] });
  const res = await sendTransaction(WALLET_ID,
    { to: USDC_ETHEREUM, data, value: '0x0', gas_limit: `0x${USDC_GAS.toString(16)}` }, CAIP2);
  const hash = res?.data?.hash ?? res?.hash;
  console.log(`      ${hash}`);
  const r = await c.waitForTransactionReceipt({ hash, timeout: 300_000 });
  console.log(`      ${r.status}`);
  if (r.status !== 'success') { console.error('USDC transfer REVERTED - stopping.'); process.exit(1); }
}

if (ethToSend > 0n) {
  console.log('\n[2/2] sending ETH...');
  // Re-read: the USDC send consumed gas, so the earlier figure is stale.
  const left = await c.getBalance({ address: FROM });
  const send = left > ethCost ? left - ethCost : 0n;
  if (send <= 0n) { console.log('      nothing left after gas - skipping'); process.exit(0); }
  const res = await sendTransaction(WALLET_ID,
    { to: DEST, value: `0x${send.toString(16)}`, gas_limit: `0x${ETH_GAS.toString(16)}` }, CAIP2);
  const hash = res?.data?.hash ?? res?.hash;
  console.log(`      ${formatEther(send)} ETH  ${hash}`);
  const r = await c.waitForTransactionReceipt({ hash, timeout: 300_000 });
  console.log(`      ${r.status}`);
}

console.log('\nDone. Verify on https://etherscan.io/address/' + DEST);
