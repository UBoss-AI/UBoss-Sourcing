/**
 * Rotating a secret must not sign anybody out or lose a stored credential
 * (LIVE-018).
 *
 * The operating procedure in docs/DEPLOYMENT.md "Rotating secrets" is: put the
 * new value in the current setting, move the old one to its `_PREVIOUS`
 * setting, restart, and remove the old value once everything it signed has
 * expired. That only works if, during the window, BOTH values verify and only
 * the NEW one signs. This file proves that for each kind of secret:
 *
 *   - the session cookie signature (what `app.ts` hands `@fastify/cookie`)
 *   - the access token
 *   - a printed document's verification code (keyed from the session secret)
 *   - the credential vault: an envelope written under the previous key opens,
 *     the re-encryption pass moves it to the current key, and the old key can
 *     then be dropped without anything becoming unreadable.
 *
 * `config/env.ts` parses `process.env` once, at import. So every case sets the
 * environment it wants FIRST and imports the modules afterwards, with the
 * module cache reset in between.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OLD_SESSION = 'old-session-secret-0123456789abcdefghijklmnop';
const NEW_SESSION = 'new-session-secret-0123456789abcdefghijklmnop';
const OLD_ACCESS = 'old-access-token-secret-0123456789abcdefghijk';
const NEW_ACCESS = 'new-access-token-secret-0123456789abcdefghijk';

const saved: Record<string, string | undefined> = {};
const TOUCHED = [
  'SESSION_COOKIE_SECRET',
  'SESSION_COOKIE_SECRET_PREVIOUS',
  'ACCESS_TOKEN_SECRET',
  'ACCESS_TOKEN_SECRET_PREVIOUS',
  'SECRETS_KEY_PROVIDER',
  'SECRETS_ENCRYPTION_KEY',
  'SECRETS_ENCRYPTION_KEY_PREVIOUS',
];

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

beforeEach(() => {
  for (const key of TOUCHED) saved[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved[key];
  }
  vi.doUnmock('../../src/infra/prisma.js');
  vi.resetModules();
});

/** An access token exactly as session.service.ts signs one, under `secret`. */
function accessTokenSignedWith(secret: string, sub = 'user-1'): string {
  const claims = {
    sub,
    sid: 'session-1',
    typ: 'CUSTOMER',
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

describe('session cookie signatures during a rotation', () => {
  it('verifies a cookie signed with the previous secret, and signs new ones with the current', async () => {
    // Before the rotation: the old value is the only one.
    setEnv({ SESSION_COOKIE_SECRET: OLD_SESSION, SESSION_COOKIE_SECRET_PREVIOUS: '' });
    const before = await import('../../src/infra/signing-secrets.js');
    const { Signer } = await import('@fastify/cookie');
    const issuedBefore = new Signer([...before.sessionSecrets()]).sign('session-id-123');

    // The rotation: new value current, old value previous, restart.
    vi.resetModules();
    setEnv({ SESSION_COOKIE_SECRET: NEW_SESSION, SESSION_COOKIE_SECRET_PREVIOUS: OLD_SESSION });
    const during = await import('../../src/infra/signing-secrets.js');
    const secrets = during.sessionSecrets();

    // Current first: that is the one @fastify/cookie signs with.
    expect(secrets).toEqual([NEW_SESSION, OLD_SESSION]);

    const signer = new Signer([...secrets]);
    const opened = signer.unsign(issuedBefore);
    expect(opened.valid).toBe(true);
    expect(opened.value).toBe('session-id-123');
    // ...and the plugin tells the app to re-sign it under the new value.
    expect(opened.renew).toBe(true);

    const issuedDuring = signer.sign('session-id-456');
    expect(new Signer([NEW_SESSION]).unsign(issuedDuring).valid).toBe(true);
    expect(new Signer([OLD_SESSION]).unsign(issuedDuring).valid).toBe(false);

    // After the window: the old value removed, the old cookie stops working.
    vi.resetModules();
    setEnv({ SESSION_COOKIE_SECRET: NEW_SESSION, SESSION_COOKIE_SECRET_PREVIOUS: '' });
    const after = await import('../../src/infra/signing-secrets.js');
    expect(new Signer([...after.sessionSecrets()]).unsign(issuedBefore).valid).toBe(false);
  });

  it('ignores blanks and a previous value equal to the current one', async () => {
    setEnv({
      SESSION_COOKIE_SECRET: NEW_SESSION,
      SESSION_COOKIE_SECRET_PREVIOUS: ` ${NEW_SESSION} , , ${OLD_SESSION} `,
    });
    const { sessionSecrets } = await import('../../src/infra/signing-secrets.js');
    expect(sessionSecrets()).toEqual([NEW_SESSION, OLD_SESSION]);
  });
});

describe('access tokens during a rotation', () => {
  it('accepts a token signed with ACCESS_TOKEN_SECRET_PREVIOUS until it is removed', async () => {
    const oldToken = accessTokenSignedWith(OLD_ACCESS);

    setEnv({ ACCESS_TOKEN_SECRET: NEW_ACCESS, ACCESS_TOKEN_SECRET_PREVIOUS: OLD_ACCESS });
    const during = await import('../../src/modules/identity/session.service.js');
    expect(during.verifyAccessToken(oldToken)?.sub).toBe('user-1');
    expect(during.verifyAccessToken(accessTokenSignedWith(NEW_ACCESS))?.sub).toBe('user-1');
    // A secret that was never ours is still refused.
    expect(during.verifyAccessToken(accessTokenSignedWith('x'.repeat(40)))).toBeNull();

    vi.resetModules();
    setEnv({ ACCESS_TOKEN_SECRET: NEW_ACCESS, ACCESS_TOKEN_SECRET_PREVIOUS: '' });
    const after = await import('../../src/modules/identity/session.service.js');
    expect(after.verifyAccessToken(oldToken)).toBeNull();
  });
});

describe('document verification codes during a rotation', () => {
  it('still recognises a code printed under the previous session secret', async () => {
    setEnv({ SESSION_COOKIE_SECRET: OLD_SESSION, SESSION_COOKIE_SECRET_PREVIOUS: '' });
    const before = await import('../../src/modules/documents/document-format.js');
    const printed = before.verificationCode('invoice', 'INV/26-27/00001', 'seller-1');

    vi.resetModules();
    setEnv({ SESSION_COOKIE_SECRET: NEW_SESSION, SESSION_COOKIE_SECRET_PREVIOUS: OLD_SESSION });
    const during = await import('../../src/modules/documents/document-format.js');
    expect(during.verificationCodeMatches('invoice', 'INV/26-27/00001', printed, 'seller-1')).toBe(
      true,
    );
    // New documents carry a code under the NEW secret.
    expect(during.verificationCode('invoice', 'INV/26-27/00001', 'seller-1')).not.toBe(printed);
    // The code is still bound to its issuer: another seller's number does not match.
    expect(during.verificationCodeMatches('invoice', 'INV/26-27/00001', printed, 'seller-2')).toBe(
      false,
    );
  });
});

describe('the credential vault during a key rotation', () => {
  const oldKey = randomBytes(32).toString('base64');
  const newKey = randomBytes(32).toString('base64');

  it('opens an envelope written under the previous key, and writes new ones under the current', async () => {
    setEnv({
      SECRETS_KEY_PROVIDER: 'env',
      SECRETS_ENCRYPTION_KEY: oldKey,
      SECRETS_ENCRYPTION_KEY_PREVIOUS: '',
    });
    const before = await import('../../src/infra/crypto.js');
    const stored = before.encryptSecret('sk_live_gateway_key', 'payment_connection:01ABC');

    vi.resetModules();
    setEnv({ SECRETS_ENCRYPTION_KEY: newKey, SECRETS_ENCRYPTION_KEY_PREVIOUS: oldKey });
    const during = await import('../../src/infra/crypto.js');

    expect(during.keyringSummary().previousKeys).toBe(1);
    expect(during.decryptSecret(stored, 'payment_connection:01ABC')).toBe('sk_live_gateway_key');
    // It opens, but it is not under the current key yet - re-encryption is due.
    expect(during.isUnderCurrentKey(stored, 'payment_connection:01ABC')).toBe(false);
    // The context binding still holds under the previous key.
    expect(() => during.decryptSecret(stored, 'payment_connection:01XYZ')).toThrow(
      during.SecretDecryptionError,
    );

    const fresh = during.encryptSecret('sk_live_new', 'payment_connection:01ABC');
    expect(during.isUnderCurrentKey(fresh, 'payment_connection:01ABC')).toBe(true);
  });

  it('re-encrypts every old envelope onto the current key, after which the old key can go', async () => {
    setEnv({
      SECRETS_KEY_PROVIDER: 'env',
      SECRETS_ENCRYPTION_KEY: oldKey,
      SECRETS_ENCRYPTION_KEY_PREVIOUS: '',
    });
    const before = await import('../../src/infra/crypto.js');

    // A tiny in-memory "users" table with MFA secrets written under the old key.
    const rows = new Map<string, string>();
    const { ENCRYPTED_COLUMNS: specsBefore } = await import('../../src/infra/secret-reencrypt.js');
    const userSpec = specsBefore.find((spec) => spec.table === 'users');
    expect(userSpec).toBeDefined();
    for (const id of ['01A', '01B', '01C']) {
      const row: Record<string, string> = { id };
      const aad = userSpec?.aad(row)[0];
      rows.set(id, before.encryptSecret(`totp-${id}`, aad));
    }

    // The rotation, with the database replaced by the map above.
    vi.resetModules();
    setEnv({ SECRETS_ENCRYPTION_KEY: newKey, SECRETS_ENCRYPTION_KEY_PREVIOUS: oldKey });
    vi.doMock('../../src/infra/prisma.js', () => ({
      prisma: {
        $queryRawUnsafe: (_sql: string, after: string) =>
          Promise.resolve(
            [...rows.entries()]
              .filter(([id]) => id > after)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, value]) => ({ id, mfaSecretEnc: value })),
          ),
        $executeRawUnsafe: (_sql: string, sealed: string, id: string, expected: string) => {
          if (rows.get(id) !== expected) return Promise.resolve(0);
          rows.set(id, sealed);
          return Promise.resolve(1);
        },
      },
    }));

    const during = await import('../../src/infra/crypto.js');
    const { reencryptColumn, ENCRYPTED_COLUMNS } = await import(
      '../../src/infra/secret-reencrypt.js'
    );
    const spec = ENCRYPTED_COLUMNS.find((entry) => entry.table === 'users');
    if (spec === undefined) throw new Error('users column spec missing');

    const dry = await reencryptColumn(spec, { dryRun: true });
    expect(dry).toMatchObject({ scanned: 3, current: 0, reencrypted: 3, unreadable: 0 });

    const report = await reencryptColumn(spec);
    expect(report).toMatchObject({ scanned: 3, current: 0, reencrypted: 3, raced: 0, unreadable: 0 });

    // A second pass finds nothing left under the old key: safe to drop it.
    const again = await reencryptColumn(spec, { dryRun: true });
    expect(again).toMatchObject({ scanned: 3, current: 3, reencrypted: 0 });

    for (const [id, envelope] of rows) {
      const aad = spec.aad({ id })[0];
      expect(during.isUnderCurrentKey(envelope, aad)).toBe(true);
    }

    // The old key removed: everything still opens.
    vi.resetModules();
    setEnv({ SECRETS_ENCRYPTION_KEY: newKey, SECRETS_ENCRYPTION_KEY_PREVIOUS: '' });
    const after = await import('../../src/infra/crypto.js');
    for (const [id, envelope] of rows) {
      const aad = spec.aad({ id })[0];
      expect(after.decryptSecret(envelope, aad)).toBe(`totp-${id}`);
    }
  });
});
