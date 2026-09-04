/**
 * Cryptographic primitives.
 *
 * Three distinct jobs, deliberately not interchangeable:
 *
 *   1. Passwords          -> Argon2id. Slow and memory-hard by design.
 *   2. Lookup tokens      -> SHA-256. Invitation, reset and payment-link tokens
 *                            are 32 bytes of CSPRNG output, so they have no
 *                            guessable structure to brute-force; the hash only
 *                            needs to be a fast, non-reversible index key.
 *   3. Stored secrets     -> AES-256-GCM. Gateway credentials and connector
 *                            keys must be readable again, so they are encrypted
 *                            rather than hashed.
 *
 * Nothing here ever logs its input.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  argon2id,
  hash as argon2Hash,
  needsRehash as argon2NeedsRehash,
  verify as argon2Verify,
  type HashOptions,
} from 'argon2';
import { secretsEncryptionKey } from '../config/env.js';

// --- Passwords -------------------------------------------------------------

/**
 * Argon2id at OWASP's recommended baseline: 19 MiB, 2 iterations, 1 lane.
 * Raising memoryCost later is safe - `verify` reads the parameters embedded in
 * the stored hash, so existing passwords keep working and rehash on next login.
 *
 * `raw` is deliberately absent: the encoded-string overload is what produces
 * the self-describing `$argon2id$v=19$m=...` digest stored in users.passwordHash.
 */
const ARGON2_OPTIONS: HashOptions = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false on a malformed stored hash rather than
 * throwing, so a corrupt row cannot be distinguished from a wrong password.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * True when the stored hash used weaker parameters than the current policy.
 *
 * All three cost parameters must be passed. `needsRehash` compares the digest
 * against argon2's own defaults for anything omitted (parallelism defaults to
 * 4, not our 1), so a partial options object reports every freshly created
 * hash as stale and rehashes on every single login.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2NeedsRehash(hash, {
      memoryCost: ARGON2_OPTIONS.memoryCost,
      timeCost: ARGON2_OPTIONS.timeCost,
      parallelism: ARGON2_OPTIONS.parallelism,
    });
  } catch {
    return true;
  }
}

// --- Random tokens ---------------------------------------------------------

/**
 * A single-use token for invitations, password resets and payment links.
 *
 * Returns the raw token (which goes in exactly one email and is never stored)
 * and its SHA-256 (which is what the database keeps). A leaked database dump
 * therefore contains no usable tokens.
 */
export function generateToken(byteLength = 32): { token: string; tokenHash: string } {
  const token = randomBytes(byteLength).toString('base64url');
  return { token, tokenHash: sha256Hex(token) };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Alphabet for temporary passwords.
 *
 * Deliberately 32 characters, and deliberately missing `I`, `O`, `0`, `1`: this
 * string is read off a screen and retyped by hand, and those four are where
 * that goes wrong. 32 divides 256 exactly, so masking a random byte with 0x1f
 * selects uniformly - no modulo bias, and no rejection loop.
 */
const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A system-issued temporary password for a new staff account.
 *
 * Four groups of four, hyphenated: 20 characters, of which 16 carry 5 bits each
 * — 80 bits of entropy, far past anything worth guessing, while still being
 * something a person can copy out of an email without a mistake.
 *
 * Generated here rather than accepted from the administrator creating the
 * account, so that nobody — including them — ever chooses another person's
 * password. It is returned once, goes into exactly one email, and only its
 * Argon2id hash is stored.
 */
export function generateTemporaryPassword(): string {
  const bytes = randomBytes(16);
  const characters = Array.from(bytes, (byte) => TEMPORARY_PASSWORD_ALPHABET[byte & 0x1f]);

  return [
    characters.slice(0, 4).join(''),
    characters.slice(4, 8).join(''),
    characters.slice(8, 12).join(''),
    characters.slice(12, 16).join(''),
  ].join('-');
}

/** Hash of a canonical request body, for idempotency-key body comparison. */
export function hashRequestBody(body: unknown): string {
  return sha256Hex(canonicalJson(body));
}

/**
 * Stable JSON: object keys sorted recursively, so two semantically identical
 * bodies produce the same hash regardless of key order on the wire.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Constant-time string comparison, for anything an attacker can submit
 * repeatedly: token lookups, webhook signatures, MFA codes.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // Length is not secret, but bail early on a mismatch so timingSafeEqual gets
  // equal-length inputs (it throws otherwise).
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

// --- Reversible secrets (AES-256-GCM) --------------------------------------

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_VERSION = 'v1';

/**
 * Encrypt a secret for storage. Output is `v1:<iv>:<tag>:<ciphertext>`, all
 * base64url. The version prefix exists so a future key rotation can decrypt old
 * envelopes while writing new ones.
 *
 * `aad` binds the ciphertext to its context (e.g. `payment_connection:<id>`),
 * so a row copied into a different record fails authentication instead of
 * decrypting into a valid-looking credential.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretsEncryptionKey, iv, {
    authTagLength: GCM_TAG_BYTES,
  });

  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export function decryptSecret(envelope: string, aad?: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4) {
    throw new SecretDecryptionError('Malformed secret envelope');
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new SecretDecryptionError(`Unsupported secret envelope version: ${String(version)}`);
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      secretsEncryptionKey,
      Buffer.from(ivPart ?? '', 'base64url'),
      { authTagLength: GCM_TAG_BYTES },
    );

    decipher.setAuthTag(Buffer.from(tagPart ?? '', 'base64url'));
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    // The underlying message can hint at key state; keep it out of the throw.
    throw new SecretDecryptionError(
      `Secret could not be decrypted (wrong key, tampered ciphertext, or context mismatch)${
        error instanceof Error ? '' : ''
      }`,
    );
  }
}

/**
 * Non-secret display hint for the admin UI, e.g. `rzp_test_...9f2a`.
 * Shows enough to identify which key is configured, never enough to use it.
 */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  const prefix = plaintext.slice(0, Math.min(12, Math.floor(plaintext.length / 3)));
  const suffix = plaintext.slice(-4);
  return `${prefix}...${suffix}`;
}
