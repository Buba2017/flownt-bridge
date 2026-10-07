import { generateKeyPairSync, createPublicKey, createDecipheriv, privateDecrypt, constants } from 'crypto';
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

const rsaDecrypt = (b64: string): Buffer => privateDecrypt(
  { key: loadOrCreatePrivateKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  Buffer.from(b64, 'base64'),
);

/** Prefix of the hybrid envelope for secrets larger than RSA-OAEP can hold (cloud tokens). */
export const HYBRID_PREFIX = 'hyb1:';

/**
 * Decrypts a secret from Flownt. Plain base64 = RSA-OAEP(SHA-256) of the secret (access
 * codes). `hyb1:` + base64(JSON {k, iv, ct}) = a random AES-256-GCM key wrapped with
 * RSA-OAEP, and the secret encrypted with it (ct = ciphertext || 16-byte tag).
 */
export function decryptSecret(ciphertext: string): string {
  if (!ciphertext.startsWith(HYBRID_PREFIX)) return rsaDecrypt(ciphertext).toString('utf-8');
  const env = JSON.parse(Buffer.from(ciphertext.slice(HYBRID_PREFIX.length), 'base64').toString('utf-8')) as
    { k?: string; iv?: string; ct?: string };
  if (!env.k || !env.iv || !env.ct) throw new Error('malformed secret envelope');
  const key = rsaDecrypt(env.k);
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.ct, 'base64');
  if (key.length !== 32 || iv.length !== 12 || data.length < 17) throw new Error('malformed secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf-8');
}
