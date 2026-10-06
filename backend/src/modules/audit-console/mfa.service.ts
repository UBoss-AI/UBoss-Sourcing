/**
 * Two-step sign-in for the Audit Console.
 *
 * The console's POLICY only - every role, every session, when
 * FEATURE_AUDIT_MFA is on (refused off in production). The mechanics are
 * `identity/mfa-core.ts`, shared with the admin console and the storefront,
 * under their own `audit_mfa` scope so a secret enrolled here is bound to this
 * surface.
 *
 * An inspector who also has a storefront account has two separate accounts
 * and two separate factors; nothing here reaches across.
 */
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  assertActiveUser,
  beginFactorEnrolment,
  confirmFactorEnrolment,
  countRecoveryCodes,
  verifyFactorCode,
  type FactorEnrolment,
} from '../identity/mfa-core.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';

export interface AuditMfaState {
  required: boolean;
  enrolled: boolean;
  sessionVerified: boolean;
  recoveryCodesRemaining: number;
}

export async function readAuditMfaState(userId: string, sessionMfaVerifiedAt: Date | null): Promise<AuditMfaState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaEnabledAt: true, mfaRecoveryCodeHashesJson: true },
  });
  return {
    required: env.FEATURE_AUDIT_MFA,
    enrolled: (user?.mfaEnabledAt ?? null) !== null,
    sessionVerified: sessionMfaVerifiedAt !== null,
    recoveryCodesRemaining: countRecoveryCodes(user?.mfaRecoveryCodeHashesJson),
  };
}

/** What the guard does with a session: let it through, or which screen it owes. */
export function auditMfaGate(state: { enrolled: boolean; sessionVerified: boolean }): 'OK' | 'SETUP_REQUIRED' | 'CHALLENGE_REQUIRED' {
  if (!env.FEATURE_AUDIT_MFA) return 'OK';
  if (!state.enrolled) return 'SETUP_REQUIRED';
  if (!state.sessionVerified) return 'CHALLENGE_REQUIRED';
  return 'OK';
}

export async function beginAuditMfaEnrolment(userId: string): Promise<FactorEnrolment> {
  const user = await assertActiveUser(userId, 'AUDIT');
  return beginFactorEnrolment({
    scope: 'audit_mfa',
    userId,
    accountName: user.email,
    issuer: `${await getMarketplaceName(prisma)} Audit`,
  });
}

export async function confirmAuditMfaEnrolment(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  await confirmFactorEnrolment({
    scope: 'audit_mfa',
    userId: params.userId,
    sessionId: params.sessionId,
    code: params.code,
    notStartedCode: ErrorCode.AUDIT_MFA_SETUP_REQUIRED,
    policy: { countFailures: false },
    onEnabled: async (tx, email) => {
      await recordAudit(
        {
          action: AuditAction.AUDIT_MFA_ENABLED,
          resourceType: 'user',
          resourceId: params.userId,
          actorType: 'AUDIT',
          actorUserId: params.userId,
          actorEmail: email,
          ipAddress: params.ipAddress ?? null,
          correlationId: params.correlationId ?? null,
        },
        tx,
      );
    },
  });
}

export async function verifyAuditMfaChallenge(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
  return verifyFactorCode({
    scope: 'audit_mfa',
    userId: params.userId,
    sessionId: params.sessionId,
    code: params.code,
    notEnrolledCode: ErrorCode.AUDIT_MFA_SETUP_REQUIRED,
    policy: { countFailures: false },
    onRecoveryUsed: async (tx, email, remaining) => {
      await recordAudit(
        {
          action: AuditAction.AUDIT_MFA_RECOVERY_USED,
          resourceType: 'user',
          resourceId: params.userId,
          actorType: 'AUDIT',
          actorUserId: params.userId,
          actorEmail: email,
          after: { recoveryCodesRemaining: remaining },
          ipAddress: params.ipAddress ?? null,
          correlationId: params.correlationId ?? null,
        },
        tx,
      );
    },
  });
}
