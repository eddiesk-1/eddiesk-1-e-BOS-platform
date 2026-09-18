import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Real, reversible encryption for values that must be genuinely
 * retrievable later — third-party API keys a business owner supplies
 * (see migrations/018_business_integrations.js), NOT passwords, which
 * stay hashed (see lib auth logic / migrations/006_credentials.js) and
 * never need this module at all. Hashing and encryption solve different
 * problems; this file exists specifically because "the server has to
 * send the real key value to an actual embeddings provider on every
 * request" cannot be satisfied by a one-way hash.
 *
 * AES-256-GCM: authenticated encryption — GCM's auth tag means a
 * tampered ciphertext (or a decryption attempt with the wrong key) fails
 * loudly rather than silently returning garbage bytes that LOOK like a
 * plausible API key. Node's built-in crypto module — no new dependency
 * for this project to carry.
 */

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. This must be a 32-byte key, base64-encoded ' +
        '(generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"). ' +
        'Deliberately separate from JWT_SECRET — a signing secret and an encryption key are ' +
        'different cryptographic jobs, and reusing one for the other is a well-known mistake ' +
        'this project is avoiding on purpose, not by oversight.',
    );
  }
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256 — got ${buf.length}. ` +
        'Regenerate with the command in the error above.',
    );
  }
  return buf;
}

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Encrypts a plaintext value (an API key) for storage. Returns three
 * separate base64 strings — matching business_integrations' three
 * columns (encrypted_api_key, encryption_iv, encryption_auth_tag)
 * exactly, rather than one concatenated blob, so the table's own
 * columns are self-describing about what each piece is for.
 */
export function encryptSecret(plaintext: string): EncryptedValue {
  const key = getEncryptionKey();
  const iv = randomBytes(12); // 96-bit IV is the GCM-recommended size
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Reverses encryptSecret(). Throws (does not return undefined or an
 * empty string) if the auth tag doesn't verify — a wrong
 * CREDENTIAL_ENCRYPTION_KEY, or a row that's been tampered with, fails
 * loudly here rather than silently handing a caller garbage bytes that
 * would then fail confusingly at the embeddings provider instead, with
 * a much less useful error.
 */
export function decryptSecret(encrypted: EncryptedValue): string {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
