#!/usr/bin/env node
/** Prove our EIP-712 domain matches the live USDC contract.
 *  A wrong name/version yields a signature that looks valid and fails on-chain,
 *  so this runs before any real payment. */
import { keccak256, toHex, encodeAbiParameters } from 'viem';
import { client, USDC, ERC20_ABI } from '../lib/chain.mjs';

const c = client();
const [name, version, onchain] = await Promise.all([
  c.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'name' }),
  c.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'version' }),
  c.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'DOMAIN_SEPARATOR' }),
]);
const TYPEHASH = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const computed = keccak256(encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
  [TYPEHASH, keccak256(toHex(name)), keccak256(toHex(version)), 8453n, USDC],
));
console.log(`name=${JSON.stringify(name)} version=${JSON.stringify(version)} chainId=8453`);
console.log(`on-chain  ${onchain}\ncomputed  ${computed}`);
if (computed.toLowerCase() !== onchain.toLowerCase()) {
  console.error('MISMATCH - signatures would fail on-chain. Do not pay.');
  process.exit(1);
}
console.log('MATCH - the EIP-712 domain we sign is correct.');
