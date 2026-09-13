#!/usr/bin/env node
/**
 * G5 - the human quorum half.
 *
 * Creates a 2-of-2 key quorum and proves it actually gates policy changes:
 * appending a rule without the required signatures must FAIL, and succeed only
 * once both approvers have signed.
 *
 * Without this, "a human quorum approves" is a claim about our UI rather than a
 * property of the system. The point is that Privy refuses the change, not that
 * our console declines to send it.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { privy, createAgentPolicy } from '../lib/privy.mjs';
import { generateAuthorizationKey, signRequest, joinSignatures } from '../lib/quorum.mjs';

const BASE = process.env.PRIVY_API_BASE ?? 'https://api.privy.io';
const APP_ID = process.env.PRIVY_APP_ID;
const keysPath = new URL('../quorum-keys.json', import.meta.url);

// ---- 1. two approver keypairs ---------------------------------------------
let keys;
if (existsSync(keysPath)) {
  keys = JSON.parse(readFileSync(keysPath, 'utf8'));
  console.log('reusing existing approver keys');
} else {
  keys = {
    approver_a: { role: 'automation', ...generateAuthorizationKey() },
    approver_b: { role: 'second human approver', ...generateAuthorizationKey() },
  };
  writeFileSync(keysPath, JSON.stringify(keys, null, 2));
  console.log('generated two approver keypairs -> quorum-keys.json (gitignored)');
}

// ---- 2. a 2-of-2 quorum ----------------------------------------------------
// Reuse an existing quorum+policy rather than orphaning them on every run.
const quorumPath = new URL('../quorum.json', import.meta.url);
if (existsSync(quorumPath) && !process.env.G5_FORCE_NEW_QUORUM) {
  const prev = JSON.parse(readFileSync(quorumPath, 'utf8'));
  console.log(`quorum ${prev.key_quorum_id} and policy ${prev.policy_id} already exist.`);
  console.log('Set G5_FORCE_NEW_QUORUM=1 to create a fresh pair.');
  process.exit(0);
}

const quorum = await privy('POST', '/v1/key_quorums', {
  display_name: 'RedFlag_Trail enforcement quorum',
  public_keys: [keys.approver_a.public_key, keys.approver_b.public_key],
  authorization_threshold: 2,
});
console.log(`key quorum ${quorum.id}  threshold=${quorum.authorization_threshold}/${quorum.authorization_keys.length}`);

// ---- 3. a policy OWNED by that quorum -------------------------------------
const policy = await privy('POST', '/v1/policies', {
  version: '1.0',
  name: 'RedFlag quorum-gated policy',
  chain_type: 'ethereum',
  owner_id: quorum.id,
  rules: [{
    name: 'Allow EIP-3009 on Base',
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions: [{ field_source: 'ethereum_typed_data_domain', field: 'chainId',
                   operator: 'eq', value: '8453' }],
  }],
});
console.log(`policy ${policy.id}  owner_id=${policy.owner_id ?? '(none)'}`);

const rule = {
  name: 'Block quorum-test vendor',
  method: 'eth_signTypedData_v4',
  action: 'DENY',
  conditions: [{
    field_source: 'ethereum_typed_data_message', field: 'to', operator: 'eq',
    value: '0x000000000000000000000000000000000000dead',
    typed_data: { primary_type: 'TransferWithAuthorization', types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    } },
  }],
};
const url = `${BASE}/v1/policies/${policy.id}/rules`;

// ---- 4. UNSIGNED must be refused ------------------------------------------
console.log('\n[unsigned]   appending a rule with no quorum signature...');
let unsigned = 'ACCEPTED';
try { await privy('POST', `/v1/policies/${policy.id}/rules`, rule); }
catch (e) { unsigned = `REFUSED ${e.status} ${e.json?.error ?? ''}`.trim(); }
console.log(`             -> ${unsigned}`);

// ---- 5. ONE signature must still be refused (threshold is 2) ---------------
const headers = { 'privy-app-id': APP_ID };
const sigA = signRequest({ method: 'POST', url, body: rule, headers,
                           privateKeyB64: keys.approver_a.private_key });
console.log('[1-of-2]     appending with ONE approver signature...');
let one = 'ACCEPTED';
try {
  await privy('POST', `/v1/policies/${policy.id}/rules`, rule,
              { 'privy-authorization-signature': sigA });
} catch (e) { one = `REFUSED ${e.status} ${e.json?.error ?? ''}`.trim(); }
console.log(`             -> ${one}`);

// ---- 6. BOTH signatures must succeed ---------------------------------------
const sigB = signRequest({ method: 'POST', url, body: rule, headers,
                           privateKeyB64: keys.approver_b.private_key });
console.log('[2-of-2]     appending with BOTH approver signatures...');
let two = 'REFUSED';
try {
  const r = await privy('POST', `/v1/policies/${policy.id}/rules`, rule,
                        { 'privy-authorization-signature': joinSignatures([sigA, sigB]) });
  two = `ACCEPTED rule_id=${r.id ?? '(none)'}`;
} catch (e) { two = `REFUSED ${e.status} ${e.json?.error ?? JSON.stringify(e.json)}`.trim(); }
console.log(`             -> ${two}`);

writeFileSync(new URL('../quorum.json', import.meta.url),
  JSON.stringify({ key_quorum_id: quorum.id, policy_id: policy.id, threshold: 2 }, null, 2));

console.log('\n' + '='.repeat(64));
const pass = unsigned.startsWith('REFUSED') && one.startsWith('REFUSED') && two.startsWith('ACCEPTED');
if (pass) {
  console.log('QUORUM PASS - Privy refused the unsigned change AND the 1-of-2 change,');
  console.log('and accepted only once both approvers signed. The quorum is enforced by');
  console.log('Privy, not by our console.');
  process.exit(0);
}
console.log('QUORUM RESULT (not the expected 2-of-2 gate):');
console.log(`  unsigned=${unsigned}\n  1-of-2  =${one}\n  2-of-2  =${two}`);
process.exit(1);
