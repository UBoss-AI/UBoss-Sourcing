/**
 * Invitation, verification and password-reset tokens.
 *
 * Shared rules for all three:
 *   - 32 bytes of CSPRNG output; only the SHA-256 is stored.
 *   - Single use, enforced by `consumedAt` inside a transaction so two
 *     simultaneous redemptions cannot both succeed.
 *   - Time limited.
 *   - Issuing a new token of a type invalidates the outstanding ones, so a
 *     resent invitation cannot be redeemed with the older link.
 *
 * Admin invitation is the primary customer onboarding path (SOP 7.1);
 * self-registration stays behind a feature flag and is off by default.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { generateToken, hashPassword, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { revokeAllUserSessions } from './session.service.js';

export type TokenPurpose = 'INVITATION' | 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** Lifetimes, in hours. Invitations are generous; resets deliberately are not. */
const TOKEN_TTL_HOURS: Readonly<Record<TokenPurpose, number>> = Object.freeze({
  INVITATION: 168, // 7 days - a business buyer may not check mail immediately.
  EMAIL_VERIFICATION: 48,
  PASSWORD_RESET: 1, // Short: a reset link in an inbox is a standing key.
});

export interface IssuedToken {
  /** Raw token. Goes into exactly one email and is never persisted. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint a token, invalidating any outstanding token of the same purpose.
 *
 * Accepts an optional transaction so an invitation is issued in the same
 * transaction that creates the customer - a rolled-back customer must not leave
 * a live invitation behind.
 */
export async function issueToken(
  userId: string,
  purpose: TokenPurpose,
  createdById?: string | null,
  tx?: PrismaTransaction,
): Promise<IssuedToken> {
  const client = tx ?? prisma;
  const { token, tokenHash } = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS[purpose] * 3_600_000);

  // Supersede outstanding tokens of this purpose. Marking them consumed is
  // simpler to reason about than deleting: the trail of who was sent what
  // survives.
  await client.authToken.updateMany({
    where: { userId, type: purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await client.authToken.create({
    data: {
      id: newId(),
      userId,
      type: purpose,
      tokenHash,
      expiresAt,
      createdById: createdById ?? null,
    },
  });

  return { token, expiresAt };
}

export interface ConsumedToken {
  userId: string;
  email: string;
  userType: 'ADMIN' | 'CUSTOMER';
}

/**
 * Redeem a token exactly once.
 *
 * The consume step is a conditional `updateMany` guarded on `consumedAt: null`;
 * two concurrent redemptions race there and exactly one sees `count === 1`.
 * A plain read-then-write would let both through.
 */
async function consumeToken(rawToken: string, purpose: TokenPurpose): Promise<ConsumedToken> {
  const tokenHash = sha256Hex(rawToken);

  return prisma.$transaction(async (tx) => {
    const record = await tx.authToken.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, email: true, type: true, status: true, archivedAt: true } },
      },
    });

    // Wrong purpose counts as invalid: a password-reset token must not be
    // redeemable as an invitation.
    if (record === null || record.type !== purpose) {
      throw badRequest(ErrorCode.TOKEN_INVALID, 'This link is not valid.');
    }

    if (record.consumedAt !== null) {
      throw badRequest(
        ErrorCode.TOKEN_ALREADY_USED,
        'This link has already been used. Request a new one if you still need it.',
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw badRequest(
        ErrorCode.TOKEN_EXPIRED,
        'This link has expired. Request a new one to continue.',
      );
    }

    if (record.user.archivedAt !== null || record.user.status === 'DEACTIVATED') {
      throw badRequest(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is no longer active.');
    }

    const claimed = await tx.authToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    if (claimed.count !== 1) {
      // Another request won the race in the moment between the read and here.
      throw badRequest(ErrorCode.TOKEN_ALREADY_USED, 'This link has already been used.');
    }

    return {
      userId: record.user.id,
      email: record.user.email,
      userType: record.user.type,
    };
  });
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  acceptedTerms: boolean;
  consentVersion: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Activate an invited account: set the password, record consent, mark active.
 *
 * All of it in one transaction. A half-activated account - password set but
 * status still PENDING_INVITATION - would be unable to sign in and unable to
 * be re-invited, because the token is already spent.
 */
export async function acceptInvitation(input: AcceptInvitationInput): Promise<ConsumedToken> {
  if (!input.acceptedTerms) {
    throw badRequest(ErrorCode.SCHEDULE_CONSENT_REQUIRED, 'You must accept the terms to continue.', [
      { field: 'acceptedTerms', code: 'CONSENT_REQUIRED' },
    ]);
  }

  const consumed = await consumeToken(input.token, 'INVITATION');
  const passwordHash = await hashPassword(input.password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: consumed.userId },
      data: {
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Customers carry consent on their profile; staff invitations have none.
    await tx.customerProfile.updateMany({
      where: { userId: consumed.userId },
      data: {
        activatedAt: now,
        consentAcceptedAt: now,
        consentVersion: input.consentVersion,
      },
    });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_ACTIVATED,
        resourceType: 'user',
        resourceId: consumed.userId,
        actorType: consumed.userType,
        actorUserId: consumed.userId,
        actorEmail: consumed.email,
        after: { status: 'ACTIVE', consentVersion: input.consentVersion },
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );
  });

  return consumed;
}

/**
 * Begin a password reset.
 *
 * Returns the token only when the account exists and can actually be reset.
 * The ROUTE must respond identically either way - disclosing "no such account"
 * here would turn the reset form into an account-enumeration oracle.
 */
export async function requestPasswordReset(
  email: string,
  context: { ipAddress?: string | null; correlationId?: string | null } = {},
): Promise<{ token: string; expiresAt: Date; userId: string; email: string } | null> {
  const emailNormalized = email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true, email: true, status: true, archivedAt: true },
  });

  if (user === null || user.archivedAt !== null || user.status !== 'ACTIVE') {
    return null;
  }

  const issued = await issueToken(user.id, 'PASSWORD_RESET');

  await recordAudit({
    action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
    resourceType: 'user',
    resourceId: user.id,
    actorType: 'SYSTEM',
    actorUserId: user.id,
    ipAddress: context.ipAddress ?? null,
    correlationId: context.correlationId ?? null,
  });

  return { token: issued.token, expiresAt: issued.expiresAt, userId: user.id, email: user.email };
}

export interface CompletePasswordResetInput {
  token: string;
  newPassword: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export async function completePasswordReset(
  input: CompletePasswordResetInput,
): Promise<ConsumedToken> {
  const consumed = await consumeToken(input.token, 'PASSWORD_RESET');
  const passwordHash = await hashPassword(input.newPassword);

  await prisma.user.update({
    where: { id: consumed.userId },
    data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
  });

  // Whoever forced the reset must not keep a live session.
  const revoked = await revokeAllUserSessions(consumed.userId, 'password_reset');

  await recordAudit({
    action: AuditAction.USER_PASSWORD_CHANGED,
    resourceType: 'user',
    resourceId: consumed.userId,
    actorType: consumed.userType,
    actorUserId: consumed.userId,
    actorEmail: consumed.email,
    after: { via: 'reset_link', sessionsRevoked: revoked },
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId ?? null,
  });

  return consumed;
}

/** Absolute URL for an emailed link, built from configured public origins. */
export function buildTokenUrl(purpose: TokenPurpose, token: string, audience: UserKindHint): string {
  const base =
    audience === 'ADMIN' ? env.ADMIN_WEB_PUBLIC_URL : env.CUSTOMER_WEB_PUBLIC_URL;

  const path =
    purpose === 'INVITATION'
      ? '/activate'
      : purpose === 'PASSWORD_RESET'
        ? '/reset-password'
        : '/verify-email';

  return `${base.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

export type UserKindHint = 'ADMIN' | 'CUSTOMER';
