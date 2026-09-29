/**
 * Mandatory, per-session TOTP for every administrator.
 *
 * The console's POLICY only. The mechanics - encryption, replay protection,
 * recovery codes - are `mfa-core.ts`, shared with the storefront's factor.
 */
import { ErrorCode } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';
import {
  assertActiveUser,
  beginFactorEnrolment,
  confirmFactorEnrolment,
  verifyFactorCode,
  type FactorEnrolment,
} from './mfa-core.js';

export type AdminMfaEnrolment = FactorEnrolment;

export async function beginAdminMfaEnrolment(userId: string): Promise<AdminMfaEnrolment> {
  const user = await assertActiveUser(userId, 'ADMIN');

  return beginFactorEnrolment({
    scope: 'admin_mfa',
    userId,
    accountName: user.email,
    // The operator's own name in the authenticator app, so a member of staff
    // sees the business that employs them rather than the software's vendor.
    issuer: `${await getMarketplaceName(prisma)} Admin`,
  });
}

export async function confirmAdminMfaEnrolment(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  await confirmFactorEnrolment({
    scope: 'admin_mfa',
    userId: params.userId,
    sessionId: params.sessionId,
    code: params.code,
    notStartedCode: ErrorCode.MFA_REQUIRED,
    policy: { countFailures: false },
    onEnabled: async (tx, email) => {
      await recordAudit(
        {
          action: AuditAction.USER_MFA_ENABLED,
          resourceType: 'user',
          resourceId: params.userId,
          actorType: 'ADMIN',
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

export async function verifyAdminMfaChallenge(params: {
  userId: string;
  sessionId: string;
  code: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
  return verifyFactorCode({
    scope: 'admin_mfa',
    userId: params.userId,
    sessionId: params.sessionId,
    code: params.code,
    notEnrolledCode: ErrorCode.MFA_REQUIRED,
    policy: { countFailures: false },
    onRecoveryUsed: async (tx, email, remaining) => {
      await recordAudit(
        {
          action: AuditAction.USER_MFA_RECOVERY_USED,
          resourceType: 'user',
          resourceId: params.userId,
          actorType: 'ADMIN',
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
