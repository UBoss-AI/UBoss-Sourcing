/** Mandatory, per-session TOTP for every administrator. */
import { ErrorCode, badRequest, conflict, forbidden } from '../../domain/errors.js';
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

function secretAad(userId: string): string {
  return `admin_mfa:${userId}`;
}

function recoveryHashes(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export interface AdminMfaEnrolment {
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

export async function beginAdminMfaEnrolment(userId: string): Promise<AdminMfaEnrolment> {
  const user = await prisma.user.findFirst({
    where: { id: userId, type: 'ADMIN', status: 'ACTIVE' },
    select: { email: true },
  });
  if (user === null) throw forbidden(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');

  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();

  await prisma.user.update({
    where: { id: userId },
    data: {
      mfaSecretEnc: encryptSecret(secret, secretAad(userId)),
      mfaEnabledAt: null,
      mfaLastCounter: null,
      mfaRecoveryCodeHashesJson: recoveryCodes.map((code) =>
        sha256Hex(normaliseRecoveryCode(code)),
      ),
    },
  });

  return {
    secret,
    uri: totpUri({ secretBase32: secret, accountName: user.email, issuer: 'UBOSS Admin' }),
    recoveryCodes,
  };
}

export async function confirmAdminMfaEnrolment(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true, mfaSecretEnc: true, mfaLastCounter: true },
  });
  if (user?.mfaSecretEnc === undefined || user.mfaSecretEnc === null) {
    throw conflict(ErrorCode.MFA_REQUIRED, 'Start two-step sign-in setup first.');
  }

  const result = verifyTotp(decryptSecret(user.mfaSecretEnc, secretAad(params.userId)), params.code, {
    atMs: Date.now(),
    lastUsedCounter: user.mfaLastCounter,
  });
  if (!result.valid || result.counter === null) {
    throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator code is not valid.');
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const spent = await tx.user.updateMany({
      where: { id: params.userId, mfaLastCounter: user.mfaLastCounter },
      data: { mfaEnabledAt: now, mfaLastCounter: result.counter },
    });
    if (spent.count !== 1) {
      throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator code was already used.');
    }
    await tx.session.update({ where: { id: params.sessionId }, data: { mfaVerifiedAt: now } });
    await recordAudit(
      {
        action: AuditAction.USER_MFA_ENABLED,
        resourceType: 'user',
        resourceId: params.userId,
        actorType: 'ADMIN',
        actorUserId: params.userId,
        actorEmail: user.email,
        ipAddress: params.ipAddress ?? null,
        correlationId: params.correlationId ?? null,
      },
      tx,
    );
  });
}

export async function verifyAdminMfaChallenge(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
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
  if (user?.mfaSecretEnc === undefined || user.mfaSecretEnc === null || user.mfaEnabledAt === null) {
    throw conflict(ErrorCode.MFA_REQUIRED, 'Set up two-step sign-in first.');
  }

  const now = new Date();
  const totp = verifyTotp(decryptSecret(user.mfaSecretEnc, secretAad(params.userId)), params.code, {
    atMs: now.getTime(),
    lastUsedCounter: user.mfaLastCounter,
  });

  if (totp.valid && totp.counter !== null) {
    await prisma.$transaction(async (tx) => {
      const spent = await tx.user.updateMany({
        where: { id: params.userId, mfaLastCounter: user.mfaLastCounter },
        data: { mfaLastCounter: totp.counter },
      });
      if (spent.count !== 1) {
        throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator code was already used.');
      }
      await tx.session.update({ where: { id: params.sessionId }, data: { mfaVerifiedAt: now } });
    });
    return {
      usedRecoveryCode: false,
      recoveryCodesRemaining: recoveryHashes(user.mfaRecoveryCodeHashesJson).length,
    };
  }

  const hashes = recoveryHashes(user.mfaRecoveryCodeHashesJson);
  const supplied = sha256Hex(normaliseRecoveryCode(params.code));
  const matchIndex = hashes.indexOf(supplied);
  if (matchIndex === -1) {
    throw badRequest(ErrorCode.MFA_INVALID, 'That authenticator or recovery code is not valid.');
  }

  const remaining = hashes.filter((_, index) => index !== matchIndex);
  await prisma.$transaction(async (tx) => {
    const spent = await tx.user.updateMany({
      where: {
        id: params.userId,
        mfaRecoveryCodeHashesJson: { equals: hashes },
      },
      data: { mfaRecoveryCodeHashesJson: remaining },
    });
    if (spent.count !== 1) {
      throw badRequest(ErrorCode.MFA_INVALID, 'That recovery code was already used.');
    }
    await tx.session.update({ where: { id: params.sessionId }, data: { mfaVerifiedAt: now } });
    await recordAudit(
      {
        action: AuditAction.USER_MFA_RECOVERY_USED,
        resourceType: 'user',
        resourceId: params.userId,
        actorType: 'ADMIN',
        actorUserId: params.userId,
        actorEmail: user.email,
        after: { recoveryCodesRemaining: remaining.length },
        ipAddress: params.ipAddress ?? null,
        correlationId: params.correlationId ?? null,
      },
      tx,
    );
  });

  return { usedRecoveryCode: true, recoveryCodesRemaining: remaining.length };
}
