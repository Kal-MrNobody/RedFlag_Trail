// Base-chain helpers. The EIP-712 domain below is not assumed - it is verified
// against the live contract's DOMAIN_SEPARATOR by scripts/g2-verify-domain.mjs,
// which recomputes it and compares. A wrong name/version produces a signature
// that looks valid and silently fails on-chain, so this is checked, not trusted.
import { createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { base } from 'viem/chains';

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;

export const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'DOMAIN_SEPARATOR', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
];

// EIP-3009. The (v, r, s) variant - selector 0xe3ee160e, confirmed against the
// deployed contract.
export const EIP3009_ABI = [
  {
    name: 'transferWithAuthorization', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
];

export function client() {
  const url = process.env.BASE_RPC_URL;
  if (!url) throw new Error('BASE_RPC_URL not set');
  return createPublicClient({ chain: base, transport: http(url) });
}

export const usdc = (human) => parseUnits(String(human), USDC_DECIMALS);
export const fromUsdc = (raw) => formatUnits(raw, USDC_DECIMALS);

/** Split a 65-byte 0x signature into v, r, s for the EIP-3009 call. */
export function splitSignature(sig) {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (hex.length !== 130) throw new Error(`expected a 65-byte signature, got ${hex.length / 2} bytes`);
  const r = '0x' + hex.slice(0, 64);
  const s = '0x' + hex.slice(64, 128);
  let v = parseInt(hex.slice(128, 130), 16);
  // Some signers return 0/1; EIP-3009 expects 27/28.
  if (v < 27) v += 27;
  return { v, r, s };
}
