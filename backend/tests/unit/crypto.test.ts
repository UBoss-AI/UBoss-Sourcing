/**
 * Cryptographic primitives.
 *
 * Each test here maps to a specific way the system could leak: a password
 * stored recoverably, a token that survives a database dump in usable form, a
 * gateway credential that decrypts in the wrong context, an idempotency replay
 * that slips past because key order changed.
 */
import { describe, expect, it } from 'vitest';
import {
  SecretDecryptionError,
  decryptSecret,
  encryptSecret,
  generateToken,
  hashPassword,
  hashRequestBody,
  maskSecret,
  needsRehash,
  safeCompare,
  sha256Hex,
  verifyPassword,
} from '../../src/infra/crypto.js';

describe('password hashing', () => {
  it('produces an argon2id digest, never the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'same-password')).toBe(true);
    expect(await verifyPassword(b, 'same-password')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('right-password');
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    // A corrupt row must be indistinguishable from a wrong password, so a
    // thrown 500 cannot be used to probe which accounts have damaged records.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('does not ask to rehash a digest that already meets policy', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('treats an unparseable digest as needing a rehash', () => {
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('single-use tokens', () => {
  it('returns a raw token plus its hash, and only the hash is storable', () => {
    const { token, tokenHash } = generateToken();
    expect(tokenHash).toBe(sha256Hex(token));
    expect(tokenHash).toHaveLength(64);
    // The stored value must not contain the token it was derived from.
    expect(tokenHash).not.toContain(token);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken().token));
    expect(tokens.size).toBe(500);
  });

  it('is URL-safe, so it survives an email link unescaped', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('safeCompare', () => {
  it('matches identical strings and rejects near-misses', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
    expect(safeCompare('abc123', 'abc124')).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
    expect(safeCompare('', 'x')).toBe(false);
  });
});

describe('secret encryption', () => {
  it('round-trips a gateway credential', () => {
    const secret = 'rzp_test_secret_key_9f2a4b';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces different ciphertext each time, and never embeds the plaintext', () => {
    const secret = 'sk_live_abcdef123456';
    const first = encryptSecret(secret);
    const second = encryptSecret(secret);

    expect(first).not.toBe(second);
    expect(first).not.toContain(secret);
    expect(first.startsWith('v1:')).toBe(true);
  });

  it('binds ciphertext to its context, so a row copied elsewhere fails', () => {
    // The AAD is the whole point: moving a credential from one connection row
    // to another must not yield a working secret.
    const envelope = encryptSecret('secret', 'payment_connection:01ABC');
    expect(decryptSecret(envelope, 'payment_connection:01ABC')).toBe('secret');
    expect(() => decryptSecret(envelope, 'payment_connection:01XYZ')).toThrow(
      SecretDecryptionError,
    );
    expect(() => decryptSecret(envelope)).toThrow(SecretDecryptionError);
  });

  it('detects tampering with the ciphertext', () => {
    const envelope = encryptSecret('secret-value');
    const parts = envelope.split(':');
    const tampered = [parts[0], parts[1], parts[2], 'AAAAAAAAAAAAAAAAAAAA'].join(':');
    expect(() => decryptSecret(tampered)).toThrow(SecretDecryptionError);
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptSecret('nonsense')).toThrow(SecretDecryptionError);
    expect(() => decryptSecret('v2:a:b:c')).toThrow(SecretDecryptionError);
  });

  it('handles unicode and long values', () => {
    const value = `${'x'.repeat(4000)}-key-₹é中文`;
    expect(decryptSecret(encryptSecret(value))).toBe(value);
  });
});

describe('maskSecret', () => {
  it('shows enough to identify a key and not enough to use it', () => {
    const masked = maskSecret('rzp_test_51H8vQrABCDEF9f2a');
    expect(masked).toContain('...');
    expect(masked).toContain('9f2a');
    expect(masked).not.toBe('rzp_test_51H8vQrABCDEF9f2a');
  });

  it('reveals nothing at all for a short value', () => {
    expect(maskSecret('abc')).toBe('****');
  });
});

describe('hashRequestBody', () => {
  it('is stable across key order, so a reordered replay is still recognised', () => {
    const a = hashRequestBody({ amount: 100, currency: 'INR', items: [{ sku: 'A', qty: 2 }] });
    const b = hashRequestBody({ items: [{ qty: 2, sku: 'A' }], currency: 'INR', amount: 100 });
    expect(a).toBe(b);
  });

  it('changes when any value changes', () => {
    const base = hashRequestBody({ amount: 100, currency: 'INR' });
    expect(hashRequestBody({ amount: 101, currency: 'INR' })).not.toBe(base);
    expect(hashRequestBody({ amount: 100, currency: 'USD' })).not.toBe(base);
  });

  it('does not confuse array order', () => {
    expect(hashRequestBody({ items: ['a', 'b'] })).not.toBe(hashRequestBody({ items: ['b', 'a'] }));
  });

  it('ignores undefined values but not null', () => {
    expect(hashRequestBody({ a: 1, b: undefined })).toBe(hashRequestBody({ a: 1 }));
    expect(hashRequestBody({ a: 1, b: null })).not.toBe(hashRequestBody({ a: 1 }));
  });
});
