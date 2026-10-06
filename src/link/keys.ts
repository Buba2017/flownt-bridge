import { generateKeyPairSync, createPublicKey, privateDecrypt, constants } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from '../config.js';

// RSA-OAEP key pair of this bridge. Flownt encrypts printer secrets (LAN access codes)
// to the public key; only this bridge can decrypt them. The private key never leaves
// ~/.flownt-bridge (mode 0600).
const KEY_FILE = join(CONFIG_DIR, 'bridge-key.pem');

function loadOrCreatePrivateKey(): string {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, 'utf-8');
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(KEY_FILE, privateKey, { encoding: 'utf-8', mode: 0o600 });
  return privateKey;
}

export function publicKeyPem(): string {
  return createPublicKey(loadOrCreatePrivateKey()).export({ type: 'spki', format: 'pem' }).toString();
}

export function decryptSecret(ciphertextB64: string): string {
  return privateDecrypt(
    { key: loadOrCreatePrivateKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(ciphertextB64, 'base64'),
  ).toString('utf-8');
}
