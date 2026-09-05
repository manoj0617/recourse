/**
 * Ed25519 keys live in a file on disk. That is the honest description and the README says so.
 *
 * This is not wallet infrastructure and does not pretend to be: there is no HSM, no key
 * derivation, no rotation and no attestation. AP2 v0.2 secures mandates with SD-JWTs and is
 * agnostic about where the issuer key lives; we sign with EdDSA, a registered JWS algorithm,
 * and leave custody as an explicitly unsolved problem (see docs/threat-model.md).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// @noble/ed25519 v2 ships no hash implementation of its own. Wiring the synchronous hook
// keeps both the sync and async call styles usable.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export class KeyError extends Error {}

export interface KeyPair {
  /** 32-byte Ed25519 seed. */
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  /** Stable identifier for the key, used as the JWS `kid` header. */
  readonly kid: string;
}

interface StoredKey {
  readonly alg: 'EdDSA';
  readonly crv: 'Ed25519';
  readonly kid: string;
  /** base64 of the 32-byte private seed. */
  readonly d: string;
  /** base64 of the 32-byte public key. */
  readonly x: string;
}

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** The kid is the first 16 hex chars of SHA-512 over the public key. Deterministic, not secret. */
function deriveKid(publicKey: Uint8Array): string {
  return Buffer.from(sha512(publicKey)).toString('hex').slice(0, 16);
}

export async function generateKeyPair(): Promise<KeyPair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, kid: deriveKid(publicKey) };
}

export function writeKeyPair(path: string, keys: KeyPair): void {
  const stored: StoredKey = {
    alg: 'EdDSA',
    crv: 'Ed25519',
    kid: keys.kid,
    d: toB64(keys.privateKey),
    x: toB64(keys.publicKey),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
}

export function readKeyPair(path: string): KeyPair {
  let stored: StoredKey;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8')) as StoredKey;
  } catch (cause) {
    throw new KeyError(`could not read key file at ${path}: ${(cause as Error).message}`);
  }
  if (stored.alg !== 'EdDSA' || stored.crv !== 'Ed25519' || !stored.d || !stored.x) {
    throw new KeyError(`key file at ${path} is not an Ed25519 EdDSA key`);
  }
  const privateKey = fromB64(stored.d);
  const publicKey = fromB64(stored.x);
  if (privateKey.length !== 32 || publicKey.length !== 32) {
    throw new KeyError(`key file at ${path} has malformed key material`);
  }
  return { privateKey, publicKey, kid: stored.kid || deriveKid(publicKey) };
}

/** Load the keypair at `path`, generating and persisting one if the file is absent. */
export async function loadOrCreateKeyPair(path: string): Promise<KeyPair> {
  if (existsSync(path)) return readKeyPair(path);
  const keys = await generateKeyPair();
  writeKeyPair(path, keys);
  return keys;
}
