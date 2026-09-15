/**
 * Time-based one-time passwords (RFC 6238, over HOTP from RFC 4226).
 *
 * The repository already has the two columns this needs - `users.mfaSecretEnc`
 * and `users.mfaEnabledAt` - and no implementation behind them. The logistics
 * portal is the first surface that genuinely requires a second factor (a
 * partner owner can invite people into a company that carries medical freight
 * across borders), so the implementation lands here.
 *
 * WHY WRITE IT RATHER THAN TAKE A DEPENDENCY
 *
 * It is forty lines of HMAC over a big-endian counter. The dependency would
 * add a supply-chain surface to a security control, for code that has not
 * changed since 2011 and cannot, because every authenticator app on earth
 * implements the same document.
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE
 *
 * The period (30s), the digit count (6) and the algorithm (SHA-1). Not because
 * they are the best available, but because they are what Google Authenticator,
 * Authy, 1Password, Microsoft Authenticator and every hardware token agree on,
 * and an operator who changes one has produced a system whose users cannot
 * enrol. The `otpauth://` URI below carries them explicitly anyway, so an app
 * that does support alternatives is told exactly what it is being handed.
 *
 * NOTHING HERE LOGS ITS INPUT. A secret or a code in a log line is the whole
 * factor, in plaintext, retained for as long as the log is.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238's default, and what every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many periods either side of now are accepted.
 *
 * One - so thirty seconds of clock skew in either direction is tolerated, and
 * a code read off a screen at the moment it rolls over still works. Two would
 * be ninety seconds of validity, which is a long time for a code somebody has
 * just read aloud over a telephone to a caller claiming to be IT support.
 */
const DEFAULT_WINDOW = 1;

// --- base32, because that is what an authenticator app reads ---------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32, without padding.
 *
 * Unpadded on purpose: the `otpauth://` URI carries the secret in a query
 * string, and `=` there is at best noisy and at worst mangled by the QR
 * libraries and password managers that parse it. Every authenticator accepts
 * the unpadded form.
 */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(encoded: string): Buffer {
  // Spaces are how people type a secret they read off a screen in groups of
  // four, and lower case is how half of them type it. Both are accepted;
  // padding is stripped because some apps emit it and some do not.
  const cleaned = encoded.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('Secret is not valid base32.');
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * A fresh secret, as base32.
 *
 * 20 bytes - 160 bits - which is the HMAC-SHA1 block size RFC 4226 recommends
 * and what every authenticator expects. Longer is not stronger here: HMAC
 * hashes anything over the block size down to it.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// --- The algorithm --------------------------------------------------------

/**
 * One HOTP code for one counter value.
 *
 * The counter is written big-endian into eight bytes. `writeBigUInt64BE`
 * rather than two 32-bit writes, because the hand-rolled version of this is
 * where the off-by-one lives in every implementation that has one.
 */
function hotp(secret: Buffer, counter: bigint): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', secret).update(counterBytes).digest();

  // Dynamic truncation, RFC 4226 §5.3. The last nibble picks the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

/** The counter for an instant. Exported so a test can pin RFC 6238's vectors. */
export function totpCounter(atMs: number): bigint {
  return BigInt(Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
}

/** The code an authenticator would be showing for this secret at this instant. */
export function totpCodeAt(secretBase32: string, atMs: number): string {
  return hotp(base32Decode(secretBase32), totpCounter(atMs));
}

/**
 * Verify a code, tolerating a little clock skew.
 *
 * Returns the counter that matched rather than a boolean, because the caller
 * must persist it: accepting the same counter twice turns a one-time password
 * into a thirty-second password, and somebody reading a code over a shoulder
 * gets a free replay. `lastUsedCounter` is what closes that.
 *
 * Every candidate is compared in constant time, and every candidate is
 * compared even after one matches - an early return leaks, through timing,
 * which window position was correct, which narrows an attacker's clock
 * estimate.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: {
    atMs: number;
    window?: number;
    /** The highest counter this account has already spent, if any. */
    lastUsedCounter?: bigint | null;
  },
): { valid: boolean; counter: bigint | null } {
  const supplied = code.replace(/\D/g, '');
  if (supplied.length !== TOTP_DIGITS) return { valid: false, counter: null };

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return { valid: false, counter: null };
  }

  const window = options.window ?? DEFAULT_WINDOW;
  const centre = totpCounter(options.atMs);

  let matched: bigint | null = null;

  for (let drift = -window; drift <= window; drift += 1) {
    const counter = centre + BigInt(drift);
    if (counter < 0n) continue;

    const candidate = hotp(secret, counter);
    if (constantTimeEquals(candidate, supplied) && matched === null) {
      matched = counter;
    }
  }

  if (matched === null) return { valid: false, counter: null };

  // Replay: this counter, or an earlier one, has already been spent.
  const lastUsed = options.lastUsedCounter ?? null;
  if (lastUsed !== null && matched <= lastUsed) {
    return { valid: false, counter: null };
  }

  return { valid: true, counter: matched };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * `issuer` appears twice - once in the label before the colon and once as a
 * parameter - and that duplication is not a mistake: older apps read the
 * label, newer ones read the parameter, and an app that reads neither shows
 * the account a name it cannot place.
 *
 * The issuer is the DEPLOYMENT's own name, passed in rather than hard-coded,
 * because this software is installed and run by the company that bought it and
 * its staff should see that company's name in their authenticator rather than
 * ours.
 */
export function totpUri(params: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}): string {
  const issuer = params.issuer.trim().length > 0 ? params.issuer.trim() : 'UBOSS';
  const label = `${issuer}:${params.accountName}`;

  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });

  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`;
}

/**
 * Recovery codes, for the phone that went in the canal.
 *
 * Ten codes, each 10 characters from an unambiguous alphabet - no O/0, no
 * I/1/l - because these get written on paper and read back by somebody who is
 * already having a bad day. Returned in plaintext exactly once; the caller
 * stores only their hashes.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(10);
    let code = '';
    for (const byte of bytes) {
      code += alphabet[byte % alphabet.length];
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }

  return codes;
}

/** Normalise a recovery code as typed: case and dashes are noise. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
