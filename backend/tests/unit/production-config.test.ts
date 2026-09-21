/**
 * "Production fails closed" - asserted rather than asserted about.
 *
 * `config/env.ts` refuses to start a production process with insecure
 * cookies, a placeholder secret, a test payment key, local disk storage, the
 * malware scanner switched off, private ERP targets permitted, or unscanned
 * document downloads enabled. That is a long list of security controls whose
 * only proof, before this file existed, was that the source read as though it
 * would work - and `outbound-http.test.ts` already carried a comment pointing
 * at "the env tests" that were not there.
 *
 * Each case below builds a complete, otherwise-valid production environment
 * and breaks exactly one thing, so a failure names the rule that stopped
 * working rather than "the config is wrong somewhere".
 *
 * Nothing here is a real credential, and nothing here is even SHAPED like
 * one. The payment keys are assembled at runtime by `paymentKey` below rather
 * than written out, because GitHub's push protection refused this file when
 * they were literals - correctly, since no scanner can tell a fake Stripe key
 * from a real one. The secrets are obvious filler.
 */
import { describe, expect, it } from 'vitest';
import { validationIssuesFor } from '../../src/config/env.js';

/** 32 bytes, base64, for AES-256-GCM. Distinct from every signing secret. */
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * A payment key of a given shape, ASSEMBLED rather than written out.
 *
 * `env.ts` decides by prefix - `startsWith('sk_live_')` and friends - so the
 * body is irrelevant to every rule below. It is built at runtime anyway,
 * because a literal `sk_live_` followed by twenty-odd characters is what a
 * real Stripe secret key looks like, and GitHub's push protection correctly
 * refuses to accept one. It blocked this file on exactly that, which is the
 * control working: a scanner cannot tell a fake key from a real one, and a
 * scanner that tried to would be the wrong scanner.
 *
 * Writing it this way keeps the tests honest about what they exercise (the
 * prefix) and keeps the repository free of anything shaped like a credential.
 */
function paymentKey(prefix: 'sk' | 'pk' | 'rk' | 'rzp', mode: 'live' | 'test'): string {
  return [prefix, mode, 'not-a-real-key'].join('_');
}

/**
 * A production environment that passes. Every negative case below is this
 * object with one key changed, which is what makes each failure legible.
 */
function productionEnv(overrides: Record<string, string | undefined> = {}): Record<
  string,
  string | undefined
> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'mysql://app:pw@127.0.0.1:3306/uboss',

    API_PUBLIC_URL: 'https://api.example.com',
    ADMIN_WEB_ORIGIN: 'https://admin.example.com',
    ADMIN_WEB_PUBLIC_URL: 'https://admin.example.com',
    CUSTOMER_WEB_ORIGIN: 'https://shop.example.com',
    CUSTOMER_WEB_PUBLIC_URL: 'https://shop.example.com',
    STORAGE_PUBLIC_BASE_URL: 'https://media.example.com',

    SESSION_COOKIE_SECRET: 'session-secret-filler-value-0000000000',
    ACCESS_TOKEN_SECRET: 'access-secret-filler-value-00000000000',
    REFRESH_TOKEN_SECRET: 'refresh-secret-filler-value-0000000000',
    SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,

    COOKIE_SECURE: 'true',
    COOKIE_SAME_SITE: 'lax',

    FEATURE_ADMIN_MFA: 'true',

    EMAIL_DRIVER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    EMAIL_FROM_NAME: 'UBOSS',
    EMAIL_FROM_ADDRESS: 'orders@example.com',

    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'uboss-media',
    S3_ACCESS_KEY_ID: 'not-a-real-access-key-id',
    S3_SECRET_ACCESS_KEY: 'not-a-real-secret-access-key',

    MALWARE_SCANNER_DRIVER: 'clamav',

    ...overrides,
  };
}

/** The issues whose path is this setting. */
function issuesFor(
  setting: string,
  overrides: Record<string, string | undefined> = {},
): string[] {
  return validationIssuesFor(productionEnv(overrides)).filter((issue) =>
    issue.startsWith(`${setting}:`),
  );
}

describe('the baseline production environment is accepted', () => {
  /**
   * If this fails, every negative case below is meaningless - they would all
   * "fail" for a reason that has nothing to do with the rule under test.
   */
  it('has no complaints about a correctly configured production process', () => {
    expect(validationIssuesFor(productionEnv())).toEqual([]);
  });
});

describe('cookies and sessions', () => {
  it('refuses an insecure session cookie', () => {
    expect(issuesFor('COOKIE_SECURE', { COOKIE_SECURE: 'false' })).toHaveLength(1);
  });

  /**
   * SEC-08. `SameSite=None` attaches the session cookie to requests from any
   * site and removes the browser-level layer under the double-submit token.
   * It was accepted in production until this rule was added.
   */
  it('refuses SameSite=None', () => {
    const issues = issuesFor('COOKIE_SAME_SITE', { COOKIE_SAME_SITE: 'none' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('cross-site');
  });

  it('still allows strict, which is tighter rather than looser', () => {
    expect(issuesFor('COOKIE_SAME_SITE', { COOKIE_SAME_SITE: 'strict' })).toEqual([]);
  });

  /**
   * SEC-03's companion rule: a ceiling below the sliding window it caps would
   * end every session early and make the refresh setting mean nothing.
   */
  it('refuses an absolute session ceiling shorter than one refresh token', () => {
    const issues = issuesFor('SESSION_ABSOLUTE_TTL_SECONDS', {
      REFRESH_TOKEN_TTL_SECONDS: '2592000',
      SESSION_ABSOLUTE_TTL_SECONDS: '86400',
    });
    expect(issues).toHaveLength(1);
  });

  it('accepts a ceiling above it', () => {
    expect(
      issuesFor('SESSION_ABSOLUTE_TTL_SECONDS', {
        REFRESH_TOKEN_TTL_SECONDS: '2592000',
        SESSION_ABSOLUTE_TTL_SECONDS: '7776000',
      }),
    ).toEqual([]);
  });
});

describe('secrets', () => {
  it('refuses a placeholder signing secret', () => {
    for (const key of [
      'SESSION_COOKIE_SECRET',
      'ACCESS_TOKEN_SECRET',
      'REFRESH_TOKEN_SECRET',
    ] as const) {
      const issues = issuesFor(key, { [key]: 'replace-with-a-long-random-value-0000' });
      expect(issues, `${key} placeholder was accepted`).toHaveLength(1);
    }
  });

  it('refuses a signing secret shorter than 32 characters', () => {
    expect(issuesFor('ACCESS_TOKEN_SECRET', { ACCESS_TOKEN_SECRET: 'short' })).toHaveLength(1);
  });

  it('refuses an encryption key that is not 32 bytes', () => {
    const issues = issuesFor('SECRETS_ENCRYPTION_KEY', {
      SECRETS_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('32 bytes');
  });

  /**
   * SEC-09. Four settings exist so that one leaked value cannot forge a
   * session AND mint tokens AND decrypt every stored ERP credential. Pasting
   * one generated string into all four gives none of that, and nothing about
   * the running system said so.
   */
  it('refuses two purposes sharing one secret', () => {
    const shared = 'one-value-used-for-everything-000000000';

    const issues = validationIssuesFor(
      productionEnv({
        SESSION_COOKIE_SECRET: shared,
        ACCESS_TOKEN_SECRET: shared,
      }),
    );

    expect(issues.some((issue) => issue.includes('same string as'))).toBe(true);
  });

  it('refuses the encryption key being reused as a signing secret', () => {
    const issues = validationIssuesFor(
      productionEnv({ ACCESS_TOKEN_SECRET: ENCRYPTION_KEY }),
    );
    expect(issues.some((issue) => issue.includes('same string as'))).toBe(true);
  });
});

describe('uploads and malware scanning', () => {
  it('refuses to run production without ClamAV', () => {
    const issues = issuesFor('MALWARE_SCANNER_DRIVER', { MALWARE_SCANNER_DRIVER: 'disabled' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('scanned before storage');
  });

  it('refuses downloads of documents that were never scanned', () => {
    for (const flag of [
      'SELLER_ALLOW_UNSCANNED_DOCUMENTS',
      'LOGISTICS_ALLOW_UNSCANNED_DOCUMENTS',
    ]) {
      const issues = validationIssuesFor(productionEnv({ [flag]: 'true' }));
      expect(
        issues.some((issue) => issue.includes('unscanned document downloads')),
        `${flag} was accepted`,
      ).toBe(true);
    }
  });

  it('refuses local disk storage, which is neither durable nor shared', () => {
    expect(issuesFor('STORAGE_DRIVER', { STORAGE_DRIVER: 'local' })).toHaveLength(1);
  });
});

describe('outbound requests', () => {
  /**
   * The single most valuable address an SSRF can reach is the cloud metadata
   * endpoint, and this flag is what would let a form field name it.
   */
  it('refuses private and loopback ERP targets', () => {
    const issues = issuesFor('ALLOW_PRIVATE_ERP_TARGETS', {
      ALLOW_PRIVATE_ERP_TARGETS: 'true',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('metadata');
  });
});

describe('payments', () => {
  it('refuses a test payment key in production', () => {
    expect(
      issuesFor('STRIPE_SECRET_KEY', {
        STRIPE_SECRET_KEY: paymentKey('sk', 'test'),
        STRIPE_PUBLISHABLE_KEY: paymentKey('pk', 'test'),
      }),
    ).toHaveLength(1);

    expect(
      issuesFor('RAZORPAY_KEY_ID', { RAZORPAY_KEY_ID: paymentKey('rzp', 'test') }),
    ).toHaveLength(1);
  });

  it('refuses a live payment key outside production', () => {
    const issues = validationIssuesFor(
      productionEnv({
        NODE_ENV: 'development',
        STRIPE_SECRET_KEY: paymentKey('sk', 'live'),
        STRIPE_PUBLISHABLE_KEY: paymentKey('pk', 'live'),
      }),
    );

    expect(issues.some((issue) => issue.startsWith('STRIPE_SECRET_KEY:'))).toBe(true);
  });

  it('refuses a publishable and a secret key from different environments', () => {
    const issues = validationIssuesFor(
      productionEnv({
        STRIPE_SECRET_KEY: paymentKey('sk', 'live'),
        STRIPE_PUBLISHABLE_KEY: paymentKey('pk', 'test'),
      }),
    );

    expect(issues.some((issue) => issue.includes('different Stripe'))).toBe(true);
  });
});

describe('delivery of the things people are told will arrive', () => {
  it('refuses the log email driver, which delivers nothing', () => {
    const issues = issuesFor('EMAIL_DRIVER', { EMAIL_DRIVER: 'log' });
    expect(issues).toHaveLength(1);
  });

  it('refuses admin MFA being switched off', () => {
    const issues = issuesFor('FEATURE_ADMIN_MFA', { FEATURE_ADMIN_MFA: 'false' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('privileged');
  });
});

describe('the same settings outside production', () => {
  /**
   * The rules above are production-only on purpose, and that is worth pinning
   * too: a developer must still be able to run the log email driver, local
   * disk and a mock ERP on localhost. A change that tightened these
   * everywhere would break every machine in the project and would be
   * "fixed" by turning the whole check off.
   */
  it('still lets a developer run without ClamAV, on local disk, with the log mailer', () => {
    const issues = validationIssuesFor(
      productionEnv({
        NODE_ENV: 'development',
        MALWARE_SCANNER_DRIVER: 'disabled',
        STORAGE_DRIVER: 'local',
        EMAIL_DRIVER: 'log',
        SMTP_HOST: '',
        COOKIE_SECURE: 'false',
        FEATURE_ADMIN_MFA: 'false',
        ALLOW_PRIVATE_ERP_TARGETS: 'true',
      }),
    );

    expect(issues).toEqual([]);
  });
});
