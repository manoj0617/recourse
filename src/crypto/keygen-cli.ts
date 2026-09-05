/**
 * Generate the issuer keypair if it does not already exist.
 *
 *   npm run keygen
 *
 * Refuses to overwrite an existing key. Losing the key that signed a mandate means losing the
 * ability to verify that mandate later, and a one-character typo at a prompt is not a good enough
 * reason for that to happen. Delete the file deliberately if you want a new one.
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { generateKeyPair, readKeyPair, writeKeyPair } from './keys.js';

const path = process.env['RECOURSE_KEY_PATH'] ?? 'keys/issuer.json';

if (existsSync(path)) {
  const existing = readKeyPair(path);
  console.log(`A key already exists at ${path} (kid ${existing.kid}). Not overwriting it.`);
  console.log('Delete the file yourself if you intend to replace it.');
  process.exit(0);
}

const keys = await generateKeyPair();
writeKeyPair(path, keys);

console.log(`Wrote a new Ed25519 keypair to ${path}`);
console.log(`  kid: ${keys.kid}`);
console.log('');
console.log('This is a private key in a file on disk, mode 0600. It is not key custody:');
console.log('no HSM, no rotation, no attestation. Anyone who can read this file can mint');
console.log('mandates indistinguishable from the user\'s. See docs/threat-model.md.');
