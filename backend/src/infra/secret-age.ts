/**
 * How old is each secret in use - asked of the database, not of anybody's memory.
 *
 * At start-up the API records a fingerprint of every application secret it is
 * running with (`secret_fingerprints`). A fingerprint seen before keeps its
 * first-seen date; a new value starts a new row. The age of a secret is
 * therefore "now minus the first time this exact value was seen", which is
 * true without anybody writing a rotation date down, and resets on its own
 * when a secret is rotated.
 *
 * Reported three ways:
 *   - `uboss_secret_age_seconds{secret=...}` on /metrics, for alerting;
 *   - a WARN line at start-up for every secret older than SECRET_MAX_AGE_DAYS;
 *   - `npm run secrets:status`, for a person.
 *
 * Only fingerprints are stored - see `fingerprint` in key-management.ts.
 * Never throws: a secret-age report must not be what stops the API starting.
 */
import { Gauge } from 'prom-client';
import { env } from '../config/env.js';
import { newId } from './ids.js';
import { vaultKeyFingerprint } from './crypto.js';
import { fingerprint } from './key-management.js';
import { logger } from './logger.js';
import { registry } from './metrics.js';
import { prisma } from './prisma.js';

/** The secrets whose age is tracked. Credentials of external services are theirs. */
export const TRACKED_SECRETS = [
  'SESSION_COOKIE_SECRET',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'SECRETS_ENCRYPTION_KEY',
] as const;

export type TrackedSecret = (typeof TRACKED_SECRETS)[number];

const secretAge = new Gauge({
  name: 'uboss_secret_age_seconds',
  help: 'Seconds since this deployment first ran with the current value of each application secret.',
  labelNames: ['secret'],
  registers: [registry],
});

export interface SecretAge {
  secret: TrackedSecret;
  fingerprint: string;
  firstSeenAt: Date;
  ageDays: number;
  overdue: boolean;
}

/**
 * Record the values in use and report their ages.
 *
 * Takes fingerprints, never values.
 */
export async function recordSecretAges(
  fingerprints: Record<TrackedSecret, string>,
  now = new Date(),
): Promise<SecretAge[]> {
  const ages: SecretAge[] = [];

  for (const secret of TRACKED_SECRETS) {
    const print = fingerprints[secret];
    const row = await prisma.secretFingerprint.upsert({
      where: { secretName_fingerprint: { secretName: secret, fingerprint: print } },
      create: {
        id: newId(),
        secretName: secret,
        fingerprint: print,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: { lastSeenAt: now },
      select: { firstSeenAt: true },
    });

    const ageMs = Math.max(0, now.getTime() - row.firstSeenAt.getTime());
    const ageDays = Math.floor(ageMs / 86_400_000);
    const overdue = env.SECRET_MAX_AGE_DAYS > 0 && ageDays > env.SECRET_MAX_AGE_DAYS;
    secretAge.set({ secret }, Math.floor(ageMs / 1000));
    ages.push({ secret, fingerprint: print, firstSeenAt: row.firstSeenAt, ageDays, overdue });
  }

  return ages;
}

/** The start-up call: record, warn about anything overdue, never fail. */
export async function reportSecretAges(): Promise<SecretAge[]> {
  try {
    const ages = await recordSecretAges(currentFingerprints());
    for (const age of ages.filter((entry) => entry.overdue)) {
      logger.warn(
        { secret: age.secret, ageDays: age.ageDays, maxAgeDays: env.SECRET_MAX_AGE_DAYS },
        'secret is older than SECRET_MAX_AGE_DAYS - rotate it (docs/DEPLOYMENT.md, "Rotating secrets")',
      );
    }
    return ages;
  } catch (error) {
    logger.warn({ err: error }, 'could not record secret ages');
    return [];
  }
}

/** Fingerprints of this process's own secrets. The vault key's covers every provider. */
export function currentFingerprints(): Record<TrackedSecret, string> {
  return {
    SESSION_COOKIE_SECRET: fingerprint(env.SESSION_COOKIE_SECRET),
    ACCESS_TOKEN_SECRET: fingerprint(env.ACCESS_TOKEN_SECRET),
    REFRESH_TOKEN_SECRET: fingerprint(env.REFRESH_TOKEN_SECRET),
    SECRETS_ENCRYPTION_KEY: vaultKeyFingerprint(),
  };
}
