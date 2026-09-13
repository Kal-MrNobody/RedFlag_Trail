// Privy authorization-signature signing, for key-quorum-owned policies.
//
// Spec confirmed from Privy's docs (NOTES.md 12.1):
//   canonical payload -> RFC 8785 JSON canonicalization
//                     -> SHA-256
//                     -> ECDSA P-256 (secp256r1)
//                     -> ASN.1/DER signature
//                     -> standard base64 in `privy-authorization-signature`
// Multiple signatures are comma-separated when a quorum requires more than one.

import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';

/** RFC 8785 (JCS): keys sorted lexicographically by UTF-16 code unit, no
 *  insignificant whitespace. Getting this wrong produces a signature that
 *  verifies against the wrong bytes, which fails as an opaque 401. */
export function canonicalize(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

/** Generate a P-256 authorization keypair.
 *  Returns the public key as base64 DER (SPKI) - the form `public_keys` wants -
 *  and the private key as base64 DER (PKCS#8). */
export function generateAuthorizationKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function loadPrivateKey(b64) {
  // Privy prefixes exported keys with `wallet-auth:`; strip it before decoding.
  const clean = b64.startsWith('wallet-auth:') ? b64.slice('wallet-auth:'.length) : b64;
  return createPrivateKey({
    key: Buffer.from(clean, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

export function publicKeyFromPrivate(b64) {
  return createPublicKey(loadPrivateKey(b64))
    .export({ type: 'spki', format: 'der' }).toString('base64');
}

/**
 * Sign one request.
 *
 * @param method  POST | PUT | PATCH | DELETE (GET is never signed)
 * @param url     full URL, e.g. https://api.privy.io/v1/policies/xxx/rules
 * @param body    the request body object (or undefined)
 * @param headers must include privy-app-id; may include privy-idempotency-key
 *                and privy-request-expiry
 */
export function signRequest({ method, url, body, headers, privateKeyB64 }) {
  const payload = { version: 1, method, url, headers };
  if (body !== undefined) payload.body = body;

  const serialized = canonicalize(payload);
  const signer = createSign('SHA256');
  signer.update(serialized);
  signer.end();
  // Node emits ASN.1/DER for EC by default, which is what Privy expects.
  return signer.sign(loadPrivateKey(privateKeyB64)).toString('base64');
}

/** Comma-separated, as Privy documents for multi-signature quorums. */
export const joinSignatures = (sigs) => sigs.join(',');
