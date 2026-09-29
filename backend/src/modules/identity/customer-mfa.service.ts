/**
 * Two-step sign-in and step-up for storefront accounts - buyers and sellers.
 *
 * THE POLICY (the owner's decision, recorded in docs/PRD.md):
 *
 *   - OPTIONAL for every buyer and seller. An account that switches it on is
 *     asked for a code at every sign-in (`assertCustomerSecondFactor` in the
 *     customer guard), and may switch it off again after a fresh step-up.
 *   - MANDATORY for a seller's owner and for anybody whose seller role holds
 *     payout or finance permissions (`memberRequiresMfa`). The Seller Hub
 *     refuses them with MFA_SETUP_REQUIRED - which the storefront turns into
 *     the setup screen, never a dead end - and they cannot switch it off while
 *     they hold the role.
 *   - STEP-UP before a sensitive act: the session must have confirmed it is
 *     still the holder within STEP_UP_WINDOW_SECONDS. With a factor that means
 *     a code; without one, the password. Signing in counts, for the same
 *     window, when the sign-in needed no code.
 *
 * The mechanics are `mfa-core.ts`, shared with the console's factor. Only the
 * rules are here.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode, badRequest, conflict, forbidden } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { verifyPassword } from '../../infra/crypto.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { enqueueNotification } from '../notifications/notification.service.js';
import { findSellerMembership, type SellerMembership } from '../seller/account.service.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';
import {
  assertActiveUser,
  beginFactorEnrolment,
  confirmFactorEnrolment,
  countRecoveryCodes,
  regenerateRecoveryCodes,
  removeFactor,
  verifyFactorCode,
  type FactorEnrolment,
} from './mfa-core.js';

export interface RequestContext {
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** The fields of an authenticated storefront request this module reads. */
export interface CustomerSecurityAuth {
  id: string;
  email: string;
  customerProfileId: string | null;
  mfaEnabled: boolean;
  sessionId: string;
  sessionMfaVerifiedAt: Date | null;
  sessionReauthenticatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Who must have a factor
// ---------------------------------------------------------------------------

/**
 * Does this seller role require two-step sign-in?
 *
 * The owner, and anybody who can see or move the business's money: payout
 * setup is where a hijacked account turns into a stolen payout, and the
 * finance screens hold the bank details and settlement figures that make a
 * convincing invoice fraud. Read from the role's PERMISSIONS rather than a
 * list of role names, so a role that gains a finance permission later gains
 * the requirement with it.
 */
export function memberRequiresMfa(membership: Pick<SellerMembership, 'role' | 'permissions'>): boolean {
  if (!env.SELLER_MFA_REQUIRED) return false;
  return (
    membership.role === 'OWNER' ||
    membership.permissions.has(SellerPermission.FINANCE_READ) ||
    membership.permissions.has(SellerPermission.PAYOUT_SETUP)
  );
}

export type MfaRequiredReason = 'SELLER_OWNER' | 'SELLER_FINANCE' | null;

function requiredReason(membership: SellerMembership | null): MfaRequiredReason {
  if (membership === null || !memberRequiresMfa(membership)) return null;
  return membership.role === 'OWNER' ? 'SELLER_OWNER' : 'SELLER_FINANCE';
}

/**
 * The Seller Hub's second-factor gate, called by `requireSeller` after the
 * Hub's own lock. A member whose role requires a factor and has none is sent
 * to setup; one who has it passed the challenge at sign-in already (the
 * customer guard would not have let the request this far otherwise).
 */
export function assertSellerMfaSatisfied(
  membership: SellerMembership,
  auth: { mfaEnabled: boolean; sessionMfaVerifiedAt: Date | null },
): void {
  if (!memberRequiresMfa(membership)) return;

  if (!auth.mfaEnabled || auth.sessionMfaVerifiedAt === null) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.MFA_SETUP_REQUIRED,
      message:
        'Your role in this business needs two-step sign-in. Set it up to open the Seller Hub.',
      details: [{ code: requiredReason(membership) ?? 'SELLER_FINANCE' }],
    });
  }
}

export interface CustomerMfaState {
  /** The deployment offers two-step sign-in to storefront accounts at all. */
  available: boolean;
  enabled: boolean;
  /** This person's seller role requires it. */
  required: boolean;
  requiredReason: MfaRequiredReason;
  /** This session has passed its code. */
  sessionVerified: boolean;
  /** Enrolled, and this session has not passed its code yet. */
  challengePending: boolean;
  recoveryCodesRemaining: number;
  /** What a step-up asks this account for. */
  stepUpMethod: 'TOTP' | 'PASSWORD';
  /** Until when this session's last step-up counts, or null. */
  stepUpValidUntil: string | null;
}

export async function readCustomerMfaState(auth: CustomerSecurityAuth): Promise<CustomerMfaState> {
  const [user, membership] = await Promise.all([
    prisma.user.findUnique({ where: { id: auth.id }, select: { mfaRecoveryCodeHashesJson: true } }),
    auth.customerProfileId === null ? null : findSellerMembership(auth.customerProfileId),
  ]);
  const reason = requiredReason(membership);
  const validUntil =
    auth.sessionReauthenticatedAt === null
      ? null
      : new Date(auth.sessionReauthenticatedAt.getTime() + env.STEP_UP_WINDOW_SECONDS * 1000);

  return {
    available: env.FEATURE_CUSTOMER_MFA,
    enabled: auth.mfaEnabled,
    required: reason !== null,
    requiredReason: reason,
    sessionVerified: auth.sessionMfaVerifiedAt !== null,
    challengePending: challengePending(auth),
    recoveryCodesRemaining: auth.mfaEnabled ? countRecoveryCodes(user?.mfaRecoveryCodeHashesJson) : 0,
    stepUpMethod: auth.mfaEnabled ? 'TOTP' : 'PASSWORD',
    stepUpValidUntil:
      validUntil !== null && validUntil.getTime() > Date.now() ? validUntil.toISOString() : null,
  };
}

export function challengePending(auth: { mfaEnabled: boolean; sessionMfaVerifiedAt: Date | null }): boolean {
  return env.FEATURE_CUSTOMER_MFA && auth.mfaEnabled && auth.sessionMfaVerifiedAt === null;
}

// ---------------------------------------------------------------------------
// Step-up
// ---------------------------------------------------------------------------

/**
 * Refuse a sensitive act unless this session confirmed it is the holder
 * recently.
 *
 * `requireFactor` is for the acts that need a real second factor rather than
 * the password again - switching on AutoPay, today. An account without one is
 * sent to set one up (MFA_SETUP_REQUIRED), which the storefront shows inside
 * the same dialog, and finishing setup counts as the step-up.
 *
 * A no-op when FEATURE_STEP_UP is off, which production refuses.
 */
export function assertRecentStepUp(
  auth: Pick<CustomerSecurityAuth, 'mfaEnabled' | 'sessionReauthenticatedAt'>,
  options: { requireFactor?: boolean; now?: Date } = {},
): void {
  if (!env.FEATURE_STEP_UP) return;

  if (options.requireFactor === true && !auth.mfaEnabled) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.MFA_SETUP_REQUIRED,
      message: 'Set up two-step sign-in first. This needs a code from your phone, not only your password.',
      details: [{ code: 'STEP_UP_FACTOR' }],
    });
  }

  const at = auth.sessionReauthenticatedAt;
  const now = (options.now ?? new Date()).getTime();
  if (at === null || now - at.getTime() > env.STEP_UP_WINDOW_SECONDS * 1000) {
    const method = auth.mfaEnabled ? 'TOTP' : 'PASSWORD';
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.STEP_UP_REQUIRED,
      message:
        method === 'TOTP'
          ? 'Confirm it is you: enter the code from your authenticator app.'
          : 'Confirm it is you: enter your password.',
      details: [{ code: 'STEP_UP', meta: { method } }],
    });
  }
}

/**
 * Confirm it is still the holder: a code when the account has a factor, the
 * password when it does not. Marks this session re-authenticated.
 *
 * A wrong password counts towards the same lockout as a wrong sign-in; a wrong
 * code towards the factor's own. Answers 400 rather than 401 for a wrong
 * password on purpose: a 401 tells the storefront its session is dead and it
 * would refresh and resend the password.
 */
export async function stepUp(
  auth: CustomerSecurityAuth,
  input: { password?: string | null; code?: string | null },
  context: RequestContext & { userAgent?: string | null },
): Promise<{ method: 'TOTP' | 'PASSWORD'; validUntil: string }> {
  const user = await prisma.user.findUnique({
    where: { id: auth.id },
    select: { passwordHash: true, mfaEnabledAt: true, failedLoginCount: true },
  });
  if (user === null) throw forbidden(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');

  const now = new Date();
  let method: 'TOTP' | 'PASSWORD';

  if (user.mfaEnabledAt !== null && env.FEATURE_CUSTOMER_MFA) {
    method = 'TOTP';
    const code = (input.code ?? '').trim();
    if (code.length === 0) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter the code from your authenticator app.', [
        { field: 'code', code: 'REQUIRED' },
      ]);
    }
    await verifyFactorCode({
      scope: 'customer_mfa',
      userId: auth.id,
      sessionId: auth.sessionId,
      code,
      notEnrolledCode: ErrorCode.MFA_SETUP_REQUIRED,
      markReauthenticated: true,
      policy: { countFailures: true, ...context },
      onRecoveryUsed: recoveryAudit(auth, context),
    });
  } else {
    method = 'PASSWORD';
    const password = input.password ?? '';
    const matches =
      user.passwordHash !== null && password.length > 0 && (await verifyPassword(user.passwordHash, password));
    if (!matches) {
      const next = user.failedLoginCount + 1;
      await prisma.user.update({
        where: { id: auth.id },
        data: {
          failedLoginCount: next,
          ...(next >= env.LOGIN_LOCKOUT_THRESHOLD
            ? { lockedUntil: new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) }
            : {}),
        },
      });
      throw badRequest(ErrorCode.INVALID_CREDENTIALS, 'That password is not right.', [
        { field: 'password', code: 'INCORRECT' },
      ]);
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: auth.id }, data: { failedLoginCount: 0 } }),
      prisma.session.update({ where: { id: auth.sessionId }, data: { reauthenticatedAt: now } }),
    ]);
  }

  await recordAudit({
    action: AuditAction.USER_STEP_UP,
    resourceType: 'user',
    resourceId: auth.id,
    actorType: 'CUSTOMER',
    actorUserId: auth.id,
    actorEmail: auth.email,
    after: { method, sessionId: auth.sessionId },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
    correlationId: context.correlationId ?? null,
  });

  return {
    method,
    validUntil: new Date(now.getTime() + env.STEP_UP_WINDOW_SECONDS * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Enrolment, challenge, switching off
// ---------------------------------------------------------------------------

function assertAvailable(): void {
  if (!env.FEATURE_CUSTOMER_MFA) {
    throw forbidden(ErrorCode.FEATURE_DISABLED, 'Two-step sign-in is not offered on this store.');
  }
}

function recoveryAudit(auth: CustomerSecurityAuth, context: RequestContext) {
  return async (
    tx: Prisma.TransactionClient,
    email: string,
    remaining: number,
  ): Promise<void> => {
    await recordAudit(
      {
        action: AuditAction.USER_MFA_RECOVERY_USED,
        resourceType: 'user',
        resourceId: auth.id,
        actorType: 'CUSTOMER',
        actorUserId: auth.id,
        actorEmail: email,
        after: { recoveryCodesRemaining: remaining },
        ipAddress: context.ipAddress ?? null,
        correlationId: context.correlationId ?? null,
      },
      tx,
    );
  };
}

/**
 * Start (or restart) enrolment.
 *
 * Needs a fresh step-up: an intruder holding a signed-in browser could
 * otherwise put THEIR phone on the account and lock the holder out. Replacing
 * an existing factor needs the existing factor, because a step-up on an
 * account with one is by code.
 */
export async function beginCustomerMfaEnrolment(auth: CustomerSecurityAuth): Promise<FactorEnrolment> {
  assertAvailable();
  if (challengePending(auth)) {
    throw forbidden(ErrorCode.MFA_CHALLENGE_REQUIRED, 'Enter your current code first.');
  }
  assertRecentStepUp(auth);
  const user = await assertActiveUser(auth.id, 'CUSTOMER');

  return beginFactorEnrolment({
    scope: 'customer_mfa',
    userId: auth.id,
    accountName: user.email,
    // The deployment's own name, so a buyer's authenticator shows the shop they
    // buy from rather than the software it runs on.
    issuer: await getMarketplaceName(prisma),
  });
}

export async function confirmCustomerMfaEnrolment(
  auth: CustomerSecurityAuth,
  code: string,
  context: RequestContext,
): Promise<void> {
  assertAvailable();
  await confirmFactorEnrolment({
    scope: 'customer_mfa',
    userId: auth.id,
    sessionId: auth.sessionId,
    code,
    notStartedCode: ErrorCode.MFA_SETUP_REQUIRED,
    // Proving the new factor is as good a confirmation as any.
    markReauthenticated: true,
    policy: { countFailures: true, ...context },
    onEnabled: async (tx, email) => {
      await recordAudit(
        {
          action: AuditAction.USER_MFA_ENABLED,
          resourceType: 'user',
          resourceId: auth.id,
          actorType: 'CUSTOMER',
          actorUserId: auth.id,
          actorEmail: email,
          ipAddress: context.ipAddress ?? null,
          correlationId: context.correlationId ?? null,
        },
        tx,
      );
    },
  });
}

/** Pass this session's sign-in challenge. Also counts as a step-up. */
export async function verifyCustomerMfaChallenge(
  auth: CustomerSecurityAuth,
  code: string,
  context: RequestContext,
): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
  assertAvailable();
  return verifyFactorCode({
    scope: 'customer_mfa',
    userId: auth.id,
    sessionId: auth.sessionId,
    code,
    notEnrolledCode: ErrorCode.MFA_SETUP_REQUIRED,
    markReauthenticated: true,
    policy: { countFailures: true, ...context },
    onRecoveryUsed: recoveryAudit(auth, context),
  });
}

/** A fresh set of recovery codes; the old ones stop working. Step-up first. */
export async function regenerateCustomerRecoveryCodes(
  auth: CustomerSecurityAuth,
  context: RequestContext,
): Promise<string[]> {
  assertAvailable();
  if (!auth.mfaEnabled) {
    throw conflict(ErrorCode.MFA_SETUP_REQUIRED, 'Set up two-step sign-in first.');
  }
  assertRecentStepUp(auth);
  const codes = await regenerateRecoveryCodes(auth.id);
  await recordAudit({
    action: AuditAction.USER_MFA_RECOVERY_REGENERATED,
    resourceType: 'user',
    resourceId: auth.id,
    actorType: 'CUSTOMER',
    actorUserId: auth.id,
    actorEmail: auth.email,
    ipAddress: context.ipAddress ?? null,
    correlationId: context.correlationId ?? null,
  });
  return codes;
}

/**
 * Switch two-step sign-in off. Needs a fresh step-up (so, a code), and is
 * refused while the person holds a seller role that requires it. The holder
 * is emailed, because a factor switched off by somebody else is exactly the
 * thing they need to hear about while they can still act.
 */
export async function disableCustomerMfa(
  auth: CustomerSecurityAuth,
  context: RequestContext,
): Promise<void> {
  assertAvailable();
  if (!auth.mfaEnabled) return;

  const membership =
    auth.customerProfileId === null ? null : await findSellerMembership(auth.customerProfileId);
  if (membership !== null && memberRequiresMfa(membership)) {
    throw conflict(
      ErrorCode.MFA_REQUIRED_BY_ROLE,
      'Your role in the Seller Hub needs two-step sign-in, so it cannot be switched off.',
    );
  }

  assertRecentStepUp(auth);

  await prisma.$transaction(async (tx) => {
    await removeFactor(auth.id, tx);
    await recordAudit(
      {
        action: AuditAction.USER_MFA_DISABLED,
        resourceType: 'user',
        resourceId: auth.id,
        actorType: 'CUSTOMER',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: context.ipAddress ?? null,
        correlationId: context.correlationId ?? null,
      },
      tx,
    );
  });

  await enqueueNotification({
    eventKey: 'user.mfa_disabled',
    recipientEmail: auth.email,
    variables: { changedAt: new Date().toISOString() },
    relatedType: 'user',
    relatedId: auth.id,
    correlationId: context.correlationId ?? null,
  });
}
