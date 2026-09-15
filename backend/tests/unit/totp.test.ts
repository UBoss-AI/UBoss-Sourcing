/**
 * TOTP, against RFC 6238's own vectors.
 *
 * The vectors are the point of this file. A hand-rolled HOTP is forty lines
 * with exactly one place to get it wrong - the big-endian counter and the
 * dynamic truncation - and the only way to know it is right is to check it
 * against the numbers in the document every authenticator app implements.
 *
 * The RFC's SHA-1 test key is the ASCII string "12345678901234567890".
 */
import { describe, expect, it } from 'vitest';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpCodeAt,
  totpCounter,
  totpUri,
  verifyTotp,
} from '../../src/infra/totp.js';

/** RFC 6238 Appendix B, the SHA-1 key, as base32. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const input of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'hello world']) {
      const bytes = Buffer.from(input, 'utf8');
      expect(base32Decode(base32Encode(bytes)).toString('utf8')).toBe(input);
    }
  });

  it('is unpadded, because a QR library will mangle an "="', () => {
    expect(base32Encode(Buffer.from('a', 'utf8'))).not.toContain('=');
  });

  it('accepts a secret as a person types it', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    const spaced = secret.match(/.{1,4}/g)?.join(' ') ?? secret;

    expect(base32Decode(spaced.toLowerCase())).toEqual(base32Decode(secret));
  });

  it('refuses a string that is not base32', () => {
    expect(() => base32Decode('not-base32!')).toThrow(/not valid base32/);
  });
});

describe('RFC 6238 test vectors', () => {
  /**
   * Appendix B, the SHA-1 rows. The RFC prints eight digits; the six-digit
   * code every authenticator shows is the last six of each.
   */
  const VECTORS: readonly { unixSeconds: number; eightDigits: string }[] = [
    { unixSeconds: 59, eightDigits: '94287082' },
    { unixSeconds: 1_111_111_109, eightDigits: '07081804' },
    { unixSeconds: 1_111_111_111, eightDigits: '14050471' },
    { unixSeconds: 1_234_567_890, eightDigits: '89005924' },
    { unixSeconds: 2_000_000_000, eightDigits: '69279037' },
    { unixSeconds: 20_000_000_000, eightDigits: '65353130' },
  ];

  for (const vector of VECTORS) {
    it(`matches at T=${String(vector.unixSeconds)}`, () => {
      const expected = vector.eightDigits.slice(-TOTP_DIGITS);
      expect(totpCodeAt(RFC_SECRET, vector.unixSeconds * 1000)).toBe(expected);
    });
  }

  it('derives the counter the RFC says it should', () => {
    // T = floor(unix / 30). The RFC's own worked example.
    expect(totpCounter(59_000)).toBe(1n);
    expect(totpCounter(1_111_111_109_000)).toBe(37_037_036n);
  });
});

describe('verification', () => {
  const NOW = 1_111_111_111_000;

  it('accepts the current code', () => {
    const code = totpCodeAt(RFC_SECRET, NOW);
    const result = verifyTotp(RFC_SECRET, code, { atMs: NOW });

    expect(result.valid).toBe(true);
    expect(result.counter).toBe(totpCounter(NOW));
  });

  it('tolerates one period of clock skew either way', () => {
    const period = TOTP_PERIOD_SECONDS * 1000;

    for (const drift of [-period, 0, period]) {
      const code = totpCodeAt(RFC_SECRET, NOW + drift);
      expect(verifyTotp(RFC_SECRET, code, { atMs: NOW }).valid).toBe(true);
    }
  });

  it('refuses a code two periods away', () => {
    const code = totpCodeAt(RFC_SECRET, NOW + 2 * TOTP_PERIOD_SECONDS * 1000);
    expect(verifyTotp(RFC_SECRET, code, { atMs: NOW }).valid).toBe(false);
  });

  it('refuses a code that has already been spent', () => {
    /*
     * The replay control, and the reason `verifyTotp` returns the counter
     * rather than a boolean. Without spending it, a one-time password is a
     * thirty-second password and somebody reading a code over a shoulder gets
     * a free replay.
     */
    const code = totpCodeAt(RFC_SECRET, NOW);
    const first = verifyTotp(RFC_SECRET, code, { atMs: NOW });
    expect(first.valid).toBe(true);

    const second = verifyTotp(RFC_SECRET, code, {
      atMs: NOW,
      lastUsedCounter: first.counter,
    });

    expect(second.valid).toBe(false);
  });

  it('refuses an older counter even if its code is still inside the window', () => {
    const previous = totpCodeAt(RFC_SECRET, NOW - TOTP_PERIOD_SECONDS * 1000);
    const current = verifyTotp(RFC_SECRET, totpCodeAt(RFC_SECRET, NOW), { atMs: NOW });

    expect(
      verifyTotp(RFC_SECRET, previous, { atMs: NOW, lastUsedCounter: current.counter }).valid,
    ).toBe(false);
  });

  it('ignores spaces and dashes in a typed code', () => {
    const code = totpCodeAt(RFC_SECRET, NOW);
    const typed = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp(RFC_SECRET, typed, { atMs: NOW }).valid).toBe(true);
  });

  it('refuses the wrong number of digits without throwing', () => {
    expect(verifyTotp(RFC_SECRET, '12345', { atMs: NOW }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, '1234567', { atMs: NOW }).valid).toBe(false);
    expect(verifyTotp(RFC_SECRET, '', { atMs: NOW }).valid).toBe(false);
  });

  it('refuses a malformed secret without throwing', () => {
    expect(verifyTotp('not base32!', '123456', { atMs: NOW }).valid).toBe(false);
  });
});

describe('the enrolment payload', () => {
  it('mints a 160-bit secret', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('carries the issuer twice, because apps read different halves', () => {
    const uri = totpUri({
      secretBase32: RFC_SECRET,
      accountName: 'dispatch@carrier.example',
      issuer: 'Northwind Medical',
    });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    // Once in the label, once as a parameter.
    expect(uri).toContain('Northwind%20Medical%3Adispatch%40carrier.example');
    expect(uri).toContain('issuer=Northwind+Medical');
    expect(uri).toContain(`digits=${String(TOTP_DIGITS)}`);
    expect(uri).toContain(`period=${String(TOTP_PERIOD_SECONDS)}`);
  });

  it('falls back to a name rather than an empty issuer', () => {
    const uri = totpUri({ secretBase32: RFC_SECRET, accountName: 'a@b.example', issuer: '  ' });
    expect(uri).toContain('issuer=UBOSS');
  });
});

describe('recovery codes', () => {
  it('mints ten, in an unambiguous alphabet', () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);

    for (const code of codes) {
      // No O/0, no I/1/l - these get written on paper and read back by
      // somebody who is already having a bad day.
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('normalises a code as somebody types it', () => {
    expect(normaliseRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normaliseRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
  });
});
