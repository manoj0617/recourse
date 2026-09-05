/**
 * Compact JWS with EdDSA, shaped like the SD-JWTs AP2 v0.2 uses to secure mandates.
 *
 * What is implemented: the compact serialisation, the EdDSA signature, and the claim set AP2
 * relies on -- `vct` for schema versioning, `iat`, `exp`, and `checkout_hash` binding.
 *
 * What is NOT implemented, stated here rather than left for a reader to discover: selective
 * disclosure. There are no salted digests, no `_sd` array, no disclosure segments and no
 * `sd_hash`. Every claim in a Recourse mandate is visible to every holder of the token. A real
 * deployment needs SD-JWT proper; this is the shape, not the privacy property.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import type { KeyPair } from './keys.js';

export class JwsError extends Error {}

export interface JwsHeader {
  readonly alg: 'EdDSA';
  readonly typ: string;
  readonly kid?: string;
}

export function b64uEncode(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return buf.toString('base64url');
}

export function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

function b64uDecodeJson<T>(s: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;
  } catch (cause) {
    throw new JwsError(`${what} is not valid base64url JSON: ${(cause as Error).message}`);
  }
}

/**
 * base64url of SHA-256 over the exact bytes given. AP2 binds a Checkout Mandate to the
 * merchant-signed Checkout JWT with `checkout_hash`; this is how that value is produced, and it
 * must be computed over the compact serialisation rather than a re-serialised object --
 * re-serialising changes key order, and key order changes the hash.
 */
export function hashCompact(compact: string): string {
  return Buffer.from(sha256(Buffer.from(compact, 'utf8'))).toString('base64url');
}

export async function sign(
  payload: Record<string, unknown>,
  keys: KeyPair,
  typ = 'JWT',
): Promise<string> {
  const header: JwsHeader = { alg: 'EdDSA', typ, kid: keys.kid };
  const signingInput = `${b64uEncode(JSON.stringify(header))}.${b64uEncode(JSON.stringify(payload))}`;
  const signature = await ed.signAsync(Buffer.from(signingInput, 'utf8'), keys.privateKey);
  return `${signingInput}.${b64uEncode(signature)}`;
}

export interface VerifiedJws<T> {
  readonly header: JwsHeader;
  readonly payload: T;
}

/**
 * Verify signature and structure. Deliberately does NOT check `exp` -- expiry is a mandate
 * constraint evaluated by the Gate, which has to distinguish "this signature is forged" from
 * "this authorisation lapsed". Collapsing the two would report a lapsed mandate as a forgery.
 */
export async function verify<T = Record<string, unknown>>(
  compact: string,
  publicKey: Uint8Array,
): Promise<VerifiedJws<T>> {
  const parts = compact.split('.');
  if (parts.length !== 3) {
    throw new JwsError(`expected 3 compact JWS segments, got ${parts.length}`);
  }
  const [h, p, s] = parts as [string, string, string];
  const header = b64uDecodeJson<JwsHeader>(h, 'JWS header');
  if (header.alg !== 'EdDSA') {
    // Accepting only EdDSA closes the `alg: none` and algorithm-substitution families.
    throw new JwsError(`unsupported JWS alg: ${String(header.alg)}`);
  }
  let ok: boolean;
  try {
    ok = await ed.verifyAsync(b64uDecode(s), Buffer.from(`${h}.${p}`, 'utf8'), publicKey);
  } catch (cause) {
    throw new JwsError(`signature could not be verified: ${(cause as Error).message}`);
  }
  if (!ok) throw new JwsError('signature is invalid');
  return { header, payload: b64uDecodeJson<T>(p, 'JWS payload') };
}

/** Read claims without verifying. For inspection and error reporting only, never for decisions. */
export function decodeUnverified<T = Record<string, unknown>>(compact: string): T {
  const parts = compact.split('.');
  if (parts.length !== 3) throw new JwsError(`expected 3 compact JWS segments, got ${parts.length}`);
  return b64uDecodeJson<T>(parts[1] as string, 'JWS payload');
}
