/**
 * The mechanics of one TOTP second factor, shared by every surface that uses one.
 *
 * WHY THIS FILE EXISTS
 *
 * The console's mandatory factor (`admin-mfa.service.ts`) and the storefront's
 * optional-or-mandatory one (`customer-mfa.service.ts`) do exactly the same
 * things to exactly the same columns - `users.mfaSecretEnc`, `mfaEnabledAt`,
 * `mfaLastCounter`, `mfaRecoveryCodeHashesJson`, `sessions.mfaVerifiedAt` - and
 * differ only in POLICY: who must have one, which code a refusal carries, what
 * the audit row says. So the mechanics live here once and each surface keeps
 * its own rules. A second copy of "spend this counter exactly once" is where
 * the replay bug would live.
 *
 * What is shared, and therefore identical on both surfaces:
 *
 *   - The secret is AES-256-GCM encrypted and bound (as additional
 *     authenticated data) to the account AND the surface, so a ciphertext
 *     copied into another row, or read by the other surface's code, fails to
 *     decrypt instead of quietly working.
 *   - A counter is spent with a conditional UPDATE, so two requests carrying
 *     the same code cannot both succeed - the replay protection holds under a
 *     race, not only in sequence.
 *   - Recovery codes are stored as SHA-256 hashes and each is removed as it is
 *     spent, with the same conditional-update guard.
 *
 * The primitives underneath are `infra/totp.ts` and `infra/crypto.ts`.
 * Nothing here logs a secret, a code or a recovery code.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  forbidden,
  unauthorized,
  type ErrorCodeValue,
} from '../../domain/errors.js';
import { decryptSecret, encryptSecret, sha256Hex } from '../../infra/crypto.js';
import { prisma } from '../../infra/prisma.js';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpUri,
  verifyTotp,
} from '../../infra/totp.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { revokeAllUserSessions } from './session.service.js';

type Tx = Prisma.TransactionClient;

/** Which surface's secret this is. Part of the encryption's bound data. */
export type FactorScope = 'admin_mfa' | 'customer_mfa' | 'audit_mfa';

function secretAad(scope: FactorScope, userId: string): string {
  return `${scope}:${userId}`;
}

function recoveryHashes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function countRecoveryCodes(value: unknown): number {
  return recoveryHashes(value).length;
}

export interface FactorEnrolment {
  /** Base32, for somebody typing it into an authenticator by hand. */
  secret: string;
  /** `otpauth://` URI. Drawn as a QR code in the browser, never fetched. */
  uri: string;
  /** Shown once, in this response. Only their hashes are stored. */
  recoveryCodes: string[];
}

/**
 * Mint a secret and recovery codes, stored but NOT yet enabled.
 *
 * `mfaEnabledAt` stays null until `confirmFactorEnrolment` sees a working
 * code, so somebody who mis-scans can simply start again. Replacing an
 * existing factor is the same call, which is why every caller puts a step-up
 * in front of it once a factor exists.
 */
export async function beginFactorEnrolment(params: {
  scope: FactorScope;
  userId: string;
  accountName: string;
  issuer: string;
}): Promise<FactorEnrolment> {
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();

  await prisma.user.update({
    where: { id: params.userId },
    data: {
      mfaSecretEnc: encryptSecret(secret, secretAad(params.scope, params.userId)),
      mfaEnabledAt: null,
      mfaLastCounter: null,
      mfaFailedCount: 0,
      mfaRecoveryCodeHashesJson: recoveryCodes.map((code) => sha256Hex(normaliseRecoveryCode(code))),
    },
  });

  return {
    secret,
    uri: totpUri({ secretBase32: secret, accountName: params.accountName, issuer: params.issuer }),
    recoveryCodes,
  };
}

interface FailurePolicy {
  /**
   * Count wrong codes towards a lockout. On for the storefront, where the
   * factor is the only thing between a leaked password and the account; the
   * console keeps its own behaviour.
   */
  countFailures: boolean;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * A wrong code. Counted, and - at LOGIN_LOCKOUT_THRESHOLD in a row - the
 * account is locked for LOGIN_LOCKOUT_MINUTES and every session ends, so the
 * guesser has to start again from the password and the lock.
 */
async function registerWrongCode(
  userId: string,
  email: string,
  message: string,
  policy: FailurePolicy,
): Promise<never> {
  if (!policy.countFailures) throw badRequest(ErrorCode.MFA_INVALID, message);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { mfaFailedCount: { increment: 1 } },
    select: { mfaFailedCount: true },
  });

  if (updated.mfaFailedCount < env.LOGIN_LOCKOUT_THRESHOLD) {
    throw badRequest(ErrorCode.MFA_INVALID, message);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaFailedCount: 0,
      lockedUntil: new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000),
    },
  });
  const revoked = await revokeAllUserSessions(userId, 'mfa_lockout');
  await recordAudit({
    action: AuditAction.USER_MFA_LOCKED,
    resourceType: 'user',
    resourceId: userId,
    actorType: 'SYSTEM',
    actorEmail: email,
    after: { sessionsRevoked: revoked, lockMinutes: env.LOGIN_LOCKOUT_MINUTES },
    ipAddress: policy.ipAddress ?? null,
    correlationId: policy.correlationId ?? null,
  });

  throw unauthorized(
    ErrorCode.ACCOUNT_LOCKED,
    `Too many wrong codes. The account is locked for ${String(env.LOGIN_LOCKOUT_MINUTES)} minute(s); sign in again after that.`,
  );
}

/**
 * Finish enrolment with a working code, and mark this session verified.
 *
 * `onEnabled` writes the surface's own audit row inside the same transaction.
 */
export async function confirmFactorEnrolment(params: {
  scope: FactorScope;
  userId: string;
  sessionId: string;
  code: string;
  notStartedCode: ErrorCodeValue;
  /** Also count this as a fresh step-up: the person just proved the factor. */
  markReauthenticated?: boolean;
  policy: FailurePolicy;
  onEnabled?: (tx: Tx, email: string) => Promise<void>;
}): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true, mfaSecretEnc: true, mfaLastCounter: true },
  });
  if (user?.mfaSecretEnc === undefined || user.mfaSecretEnc === null) {
    throw conflict(params.notStartedCode, 'Start two-step sign-in setup first.');
  }

  const result = verifyTotp(
    decryptSecret(user.mfaSecretEnc, secretAad(params.scope, params.userId)),
    params.code,
    { atMs: Date.now(), lastUsedCounter: user.mfaLastCounter },
  );
  if (!result.valid || result.counter === null) {
    return registerWrongCode(
      params.userId,
      user.email,
      'That code is not right. Check the clock on your phone and try the current code.',
      params.policy,
    );
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const spent = await tx.user.updateMany({
      where: { id: params.userId, mfaLastCounter: user.mfaLastCounter },
      data: { mfaEnabledAt: now, mfaLastCounter: result.counter, mfaFailedCount: 0 },
    });
    if (spent.count !== 1) {
      throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator code was already used.');
    }
    await tx.session.update({
      where: { id: params.sessionId },
      data: {
        mfaVerifiedAt: now,
        ...(params.markReauthenticated === true ? { reauthenticatedAt: now } : {}),
      },
    });
    if (params.onEnabled !== undefined) await params.onEnabled(tx, user.email);
  });
}

/**
 * Pass a challenge with an authenticator code or a one-time recovery code.
 *
 * The failure message is the same for both, so a caller cannot learn which
 * kind of credential it guessed at. A recovery code is removed as it is spent.
 */
export async function verifyFactorCode(params: {
  scope: FactorScope;
  userId: string;
  sessionId: string;
  code: string;
  notEnrolledCode: ErrorCodeValue;
  markReauthenticated?: boolean;
  policy: FailurePolicy;
  onRecoveryUsed?: (tx: Tx, email: string, remaining: number) => Promise<void>;
}): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: {
      email: true,
      mfaSecretEnc: true,
      mfaEnabledAt: true,
      mfaLastCounter: true,
      mfaRecoveryCodeHashesJson: true,
    },
  });
  if (
    user?.mfaSecretEnc === undefined ||
    user.mfaSecretEnc === null ||
    user.mfaEnabledAt === null
  ) {
    throw conflict(params.notEnrolledCode, 'Set up two-step sign-in first.');
  }

  const now = new Date();
  const sessionData = {
    mfaVerifiedAt: now,
    ...(params.markReauthenticated === true ? { reauthenticatedAt: now } : {}),
  };

  const totp = verifyTotp(
    decryptSecret(user.mfaSecretEnc, secretAad(params.scope, params.userId)),
    params.code,
    { atMs: now.getTime(), lastUsedCounter: user.mfaLastCounter },
  );

  if (totp.valid && totp.counter !== null) {
    await prisma.$transaction(async (tx) => {
      const spent = await tx.user.updateMany({
        where: { id: params.userId, mfaLastCounter: user.mfaLastCounter },
        data: { mfaLastCounter: totp.counter, mfaFailedCount: 0 },
      });
      if (spent.count !== 1) {
        throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator code was already used.');
      }
      await tx.session.update({ where: { id: params.sessionId }, data: sessionData });
    });
    return {
      usedRecoveryCode: false,
      recoveryCodesRemaining: countRecoveryCodes(user.mfaRecoveryCodeHashesJson),
    };
  }

  const hashes = recoveryHashes(user.mfaRecoveryCodeHashesJson);
  const matchIndex = hashes.indexOf(sha256Hex(normaliseRecoveryCode(params.code)));
  if (matchIndex === -1) {
    return registerWrongCode(
      params.userId,
      user.email,
      'That code is not right. Use the current code from your authenticator, or one of your recovery codes.',
      params.policy,
    );
  }

  const remaining = hashes.filter((_, index) => index !== matchIndex);
  await prisma.$transaction(async (tx) => {
    const spent = await tx.user.updateMany({
      where: { id: params.userId, mfaRecoveryCodeHashesJson: { equals: hashes } },
      data: { mfaRecoveryCodeHashesJson: remaining, mfaFailedCount: 0 },
    });
    if (spent.count !== 1) {
      throw badRequest(ErrorCode.MFA_INVALID, 'That recovery code was already used.');
    }
    await tx.session.update({ where: { id: params.sessionId }, data: sessionData });
    if (params.onRecoveryUsed !== undefined) {
      await params.onRecoveryUsed(tx, user.email, remaining.length);
    }
  });

  return { usedRecoveryCode: true, recoveryCodesRemaining: remaining.length };
}

/** Replace the recovery codes, keeping the authenticator. Shown once. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { mfaRecoveryCodeHashesJson: codes.map((code) => sha256Hex(normaliseRecoveryCode(code))) },
  });
  return codes;
}

/** Remove the factor entirely: secret, counter, recovery codes. */
export async function removeFactor(userId: string, tx: Tx | typeof prisma = prisma): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: {
      mfaSecretEnc: null,
      mfaEnabledAt: null,
      mfaLastCounter: null,
      mfaFailedCount: 0,
      mfaRecoveryCodeHashesJson: [],
    },
  });
}

/** Refused for an account that is not ACTIVE on the expected surface. */
export async function assertActiveUser(
  userId: string,
  type: 'ADMIN' | 'CUSTOMER' | 'AUDIT',
): Promise<{ email: string }> {
  const user = await prisma.user.findFirst({
    where: { id: userId, type, status: 'ACTIVE' },
    select: { email: true },
  });
  if (user === null) throw forbidden(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');
  return user;
}
