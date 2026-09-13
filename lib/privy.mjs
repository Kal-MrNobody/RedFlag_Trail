import { createHash } from 'node:crypto';

// Privy REST client.
//
// Every shape here is confirmed against Privy's published node-sdk source and
// live 400s, recorded in NOTES.md §1, §6. Do not add a field that is not
// confirmed there.

const BASE = process.env.PRIVY_API_BASE ?? 'https://api.privy.io';

function auth() {
  const id = process.env.PRIVY_APP_ID;
  const secret = process.env.PRIVY_APP_SECRET;
  if (!id || !secret) throw new Error('set PRIVY_APP_ID and PRIVY_APP_SECRET');
  return { id, header: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') };
}

export async function privy(method, path, body, extraHeaders = {}) {
  const { id, header } = auth();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: header,
      'privy-app-id': id,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Privy ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

export const BASE_CHAIN_ID = 8453;
export const CAIP2_BASE = 'eip155:8453';

// EIP-3009. Field ORDER is normative - it defines the struct hash.
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/**
 * Create a policy whose happy path ALLOWs EIP-3009 signing on Base.
 *
 * Privy REJECTS `conditions: []` on eth_signTypedData_v4 ("must have at least
 * one condition"), so there is no such thing as a blanket ALLOW - every ALLOW
 * must be scoped. chainId additionally rejects operator `in` and requires a
 * NUMERICAL STRING value. All three learned from live 400s (NOTES.md §6.2).
 */
export async function createAgentPolicy(name) {
  return privy('POST', '/v1/policies', {
    version: '1.0',
    name: name.slice(0, 50),           // hard 50-char cap
    chain_type: 'ethereum',
    rules: [
      {
        name: 'Allow EIP-3009 on Base',
        method: 'eth_signTypedData_v4',
        conditions: [
          {
            field_source: 'ethereum_typed_data_domain',
            field: 'chainId',
            operator: 'eq',
            value: String(BASE_CHAIN_ID),
          },
        ],
        action: 'ALLOW',
      },
    ],
    // Idempotency key is derived from the policy NAME, not the clock. With
    // Date.now() in it a retry after a lost response produced a second policy,
    // which is the exact failure idempotency keys exist to prevent.
  }, { 'privy-idempotency-key': `pol-${createHash('sha256').update(name).digest('hex').slice(0, 32)}` });
}

export async function createWallet(policyIds = []) {
  const body = { chain_type: 'ethereum' };
  if (policyIds.length) body.policy_ids = policyIds;
  return privy('POST', '/v1/wallets', body);
}

export async function signTypedData(walletId, typed_data) {
  return privy('POST', `/v1/wallets/${walletId}/rpc`, {
    method: 'eth_signTypedData_v4',
    params: { typed_data },
  });
}

/** caip2 defaults to Base; pass 'eip155:1' for Ethereum mainnet, etc. A Privy
 *  wallet is the same address on every EVM chain, so the chain is a parameter
 *  of the SEND, not a property of the wallet. */
export async function sendTransaction(walletId, transaction, caip2 = CAIP2_BASE) {
  return privy('POST', `/v1/wallets/${walletId}/rpc`, {
    method: 'eth_sendTransaction',
    caip2,
    params: { transaction },
  });
}

/** Append a single rule. POST .../rules appends, so it cannot clobber a
 *  concurrent edit the way PATCHing the whole rules array can (NOTES.md §1.5). */
export async function appendRule(policyId, rule) {
  return privy('POST', `/v1/policies/${policyId}/rules`, rule);
}

export async function getPolicy(policyId) {
  return privy('GET', `/v1/policies/${policyId}`);
}

/** Delete one rule by id. Endpoint confirmed in NOTES.md §1 ([DOC]). Used only
 *  to RESET the fleet policies between demo runs, so the before/after signing
 *  proof starts from a clean baseline; genuine enforcement never deletes. */
export async function deleteRule(policyId, ruleId) {
  return privy('DELETE', `/v1/policies/${policyId}/rules/${ruleId}`);
}

/** Build an EIP-3009 authorization payload. Addresses are lowercased: Privy
 *  validates mixed-case addresses against their EIP-55 checksum and rejects a
 *  mismatch BEFORE the policy engine runs (NOTES.md §6.3). */
export function buildAuthorization({ from, to, value, usdc, validForSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  return {
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: BASE_CHAIN_ID,
      verifyingContract: usdc.toLowerCase(),
    },
    types: EIP3009_TYPES,
    primary_type: 'TransferWithAuthorization',
    message: {
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value: String(value),
      validAfter: '0',
      validBefore: String(now + validForSeconds),
      nonce,
    },
  };
}
