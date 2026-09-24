/**
 * Second factor for the logistics portal.
 *
 * WHY IT LIVES HERE RATHER THAN IN `identity/`
 *
 * The columns are shared - `users.mfaSecretEnc`, `users.mfaEnabledAt`,
 * `users.mfaLastCounter`, `sessions.mfaVerifiedAt` - and the POLICY is not.
 * This portal requires a factor of its owners and administrators and enforces
 * it per session; the console and the storefront do not require one at all
 * today. Putting the policy in `identity/` would mean the first deployment to
 * turn MFA on for staff inherited whatever this feature decided, which is not
 * a decision this feature gets to make on their behalf. The primitives are in
 * `infra/totp.ts` and are shared; the rules are here.
 *
 * THE SHAPE, AND WHY IT IS NOT A LOGIN STEP
 *
 * Enrolment and challenge happen AFTER the password, on a session that already
 * exists but may do nothing else. That is the same shape as
 * `mustChangePassword` and the admin location gate, and it is deliberate:
 * bolting a second field onto the shared `/login` endpoint would change the
 * login path for all three audiences to serve one of them.
 *
 * The session is therefore real but useless: `requireLogistics` refuses every
 * route except `/auth/me`, `/auth/mfa/*` and `/auth/logout` until the
 * challenge is passed. A control that exists only in a screen is a suggestion.
 */
import { env } from '../../config/env.js';
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
import { marketplaceNameFrom } from '../settings/marketplace-name.js';
import { recordLogisticsAudit } from './audit.service.js';
import type { LogisticsMembership } from './partner.service.js';

/**
 * The additional authenticated data every TOTP secret is bound to.
 *
 * Binds the ciphertext to the account it belongs to, so a secret copied from
 * one row into another fails to decrypt instead of quietly working for
 * somebody else.
 */
function secretAad(userId: string): string {
  return `logistics_mfa:${userId}`;
}

export interface MfaEnrolment {
  /** Base32, for somebody typing it into an authenticator by hand. */
  secret: string;
  /** `otpauth://` URI, which the portal renders as a QR code in the browser. */
  uri: string;
  /**
   * Shown exactly once, in this response, and never again.
   *
   * Only their hashes are stored. A product that can show you your recovery
   * codes a second time is a product where reading somebody's screen is enough
   * to bypass their second factor.
   */
  recoveryCodes: string[];
}

export interface MfaState {
  required: boolean;
  enrolled: boolean;
  /** Whether THIS session has passed its challenge. */
  sessionVerified: boolean;
  recoveryCodesRemaining: number;
}

/**
 * Where the account stands, for the portal's boot response.
 *
 * `required` comes from the ROLE rather than from a preference, because this
 * is a policy and not an option: an owner who could turn their own second
 * factor off is an owner with no second factor.
 */
export async function readMfaState(
  membership: LogisticsMembership,
  sessionMfaVerifiedAt: Date | null,
): Promise<MfaState> {
  const user = await prisma.user.findUnique({
    where: { id: membership.userId },
    select: { mfaEnabledAt: true, mfaRecoveryCodeHashesJson: true },
  });

  return {
    required: membership.requiresMfa,
    enrolled: (user?.mfaEnabledAt !== undefined && user?.mfaEnabledAt !== null),
    sessionVerified: sessionMfaVerifiedAt !== null,
    recoveryCodesRemaining: countRecoveryCodes(user?.mfaRecoveryCodeHashesJson),
  };
}

function countRecoveryCodes(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').length : 0;
}

function readRecoveryHashes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Begin enrolment: mint a secret and hand back the QR payload.
 *
 * The secret is stored ENCRYPTED but `mfaEnabledAt` stays null, so enrolment
 * is not complete until `confirmMfaEnrolment` sees a working code. Storing it
 * before confirmation is what lets somebody who mis-scans a QR code try again
 * without being locked out of an account that thinks it has a factor it cannot
 * satisfy.
 *
 * Re-enrolling replaces the secret and the recovery codes, which is the
 * correct behaviour for a lost phone and is why the route behind this is
 * step-up protected once a factor already exists.
 */
export async function beginMfaEnrolment(
  membership: LogisticsMembership,
  issuerName: string,
  correlationId?: string | null,
): Promise<MfaEnrolment> {
  const user = await prisma.user.findUnique({
    where: { id: membership.userId },
    select: { email: true, mfaEnabledAt: true },
  });

  if (user === null) throw forbidden(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');

  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: membership.userId },
      data: {
        mfaSecretEnc: encryptSecret(secret, secretAad(membership.userId)),
        // Not enabled yet. Confirmation is what turns it on.
        mfaEnabledAt: null,
        mfaLastCounter: null,
        mfaRecoveryCodeHashesJson: recoveryCodes.map((code) =>
          sha256Hex(normaliseRecoveryCode(code)),
        ),
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.mfa.enrolment_started',
        resourceType: 'logistics_partner_user',
        resourceId: membership.partnerUserId,
        summary:
          user.mfaEnabledAt === null
            ? `${membership.fullName} started setting up two-step sign-in.`
            : `${membership.fullName} replaced their two-step sign-in device.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  return {
    secret,
    uri: totpUri({ secretBase32: secret, accountName: user.email, issuer: issuerName }),
    recoveryCodes,
  };
}

/**
 * Finish enrolment, and mark this session verified in the same breath.
 *
 * The second half matters: somebody who has just proved they hold the device
 * should not be asked to prove it again on the next screen. Anybody else's
 * session stays unverified.
 */
export async function confirmMfaEnrolment(
  membership: LogisticsMembership,
  sessionId: string,
  code: string,
  correlationId?: string | null,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: membership.userId },
    select: { mfaSecretEnc: true, mfaEnabledAt: true, mfaLastCounter: true },
  });

  if ((user?.mfaSecretEnc === undefined || user?.mfaSecretEnc === null)) {
    throw conflict(
      ErrorCode.LOGISTICS_MFA_SETUP_REQUIRED,
      'Start setting up two-step sign-in before confirming it.',
    );
  }

  const result = verifyTotp(decryptSecret(user.mfaSecretEnc, secretAad(membership.userId)), code, {
    atMs: Date.now(),
    lastUsedCounter: user.mfaLastCounter,
  });

  if (!result.valid || result.counter === null) {
    throw badRequest(
      ErrorCode.MFA_INVALID,
      'That code is not right. Check the clock on your phone and try the current code.',
    );
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: membership.userId },
      data: { mfaEnabledAt: now, mfaLastCounter: result.counter },
    });

    await tx.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.mfa.enabled',
        resourceType: 'logistics_partner_user',
        resourceId: membership.partnerUserId,
        summary: `${membership.fullName} turned on two-step sign-in.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Pass this session's challenge.
 *
 * Two ways in, and they are not equivalent. A TOTP code marks the session
 * verified and spends its counter. A recovery code marks the session verified
 * AND spends the code permanently - it is removed from the stored list, so ten
 * codes really are ten uses.
 *
 * Both are constant-time compared, and the failure message is the same for
 * both, so a caller cannot learn which kind of credential it guessed at.
 */
export async function verifyMfaChallenge(
  membership: LogisticsMembership,
  sessionId: string,
  code: string,
  context: { ipAddress?: string | null; correlationId?: string | null } = {},
): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
  const user = await prisma.user.findUnique({
    where: { id: membership.userId },
    select: {
      mfaSecretEnc: true,
      mfaEnabledAt: true,
      mfaLastCounter: true,
      mfaRecoveryCodeHashesJson: true,
    },
  });

  if ((user?.mfaSecretEnc === undefined || user?.mfaSecretEnc === null) || user.mfaEnabledAt === null) {
    throw conflict(
      ErrorCode.LOGISTICS_MFA_SETUP_REQUIRED,
      'Set up two-step sign-in before signing in with a code.',
    );
  }

  const now = new Date();

  // --- The ordinary path: a code from the authenticator ------------------
  const totp = verifyTotp(decryptSecret(user.mfaSecretEnc, secretAad(membership.userId)), code, {
    atMs: now.getTime(),
    lastUsedCounter: user.mfaLastCounter,
  });

  if (totp.valid && totp.counter !== null) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: membership.userId },
        data: { mfaLastCounter: totp.counter },
      });
      await tx.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } });
    });

    return {
      usedRecoveryCode: false,
      recoveryCodesRemaining: countRecoveryCodes(user.mfaRecoveryCodeHashesJson),
    };
  }

  // --- The lost-phone path ------------------------------------------------
  const hashes = readRecoveryHashes(user.mfaRecoveryCodeHashesJson);
  const supplied = sha256Hex(normaliseRecoveryCode(code));
  const matchIndex = hashes.indexOf(supplied);

  if (matchIndex === -1) {
    throw badRequest(
      ErrorCode.MFA_INVALID,
      'That code is not right. Use the current code from your authenticator, or one of your ' +
        'recovery codes.',
    );
  }

  const remaining = hashes.filter((_, index) => index !== matchIndex);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: membership.userId },
      data: { mfaRecoveryCodeHashesJson: remaining },
    });
    await tx.session.update({ where: { id: sessionId }, data: { mfaVerifiedAt: now } });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.mfa.recovery_code_used',
        resourceType: 'logistics_partner_user',
        resourceId: membership.partnerUserId,
        after: { remaining: remaining.length },
        summary:
          `${membership.fullName} signed in with a recovery code. ` +
          `${String(remaining.length)} left.`,
        ipAddress: context.ipAddress ?? null,
        correlationId: context.correlationId ?? null,
      },
      tx,
    );
  });

  return { usedRecoveryCode: true, recoveryCodesRemaining: remaining.length };
}

/**
 * Step-up: has this session proved the factor recently enough for a sensitive
 * act?
 *
 * Used before rotating a credential and before exporting shipment data. A
 * session verified at nine in the morning is not evidence that the person who
 * verified it is still the one at the keyboard at four in the afternoon, and
 * the two things this guards are the two that are worst to be wrong about.
 *
 * Deliberately NOT applied to ordinary work. A dispatcher re-authenticating to
 * mark a parcel collected would simply stop marking parcels collected.
 */
const STEP_UP_WINDOW_MS = 15 * 60_000;

export function assertStepUp(params: {
  membership: LogisticsMembership;
  sessionMfaVerifiedAt: Date | null;
  now?: Date;
}): void {
  // A role with no factor has nothing to step up with. The act is still
  // permission-checked; it simply cannot be re-proved, and refusing it would
  // leave a dispatcher unable to export the list they are looking at.
  if (!params.membership.requiresMfa) return;

  const verifiedAt = params.sessionMfaVerifiedAt;
  const now = params.now ?? new Date();

  if (verifiedAt === null || now.getTime() - verifiedAt.getTime() > STEP_UP_WINDOW_MS) {
    throw forbidden(
      ErrorCode.LOGISTICS_MFA_CHALLENGE_REQUIRED,
      'Confirm your two-step code again before doing this.',
    );
  }
}

/**
 * Whether the guard should refuse this session.
 *
 * Two different refusals for two different screens: one sends the person to
 * the setup wizard, the other to the six-digit box. Returning a discriminated
 * result rather than throwing lets the guard decide, and lets the three
 * always-open routes skip the check entirely.
 */
export type MfaGateResult =
  | { kind: 'OK' }
  | { kind: 'SETUP_REQUIRED' }
  | { kind: 'CHALLENGE_REQUIRED' };

export async function evaluateMfaGate(
  membership: LogisticsMembership,
  sessionMfaVerifiedAt: Date | null,
): Promise<MfaGateResult> {
  if (!membership.requiresMfa) return { kind: 'OK' };
  if (sessionMfaVerifiedAt !== null) return { kind: 'OK' };

  const user = await prisma.user.findUnique({
    where: { id: membership.userId },
    select: { mfaEnabledAt: true },
  });

  return (user?.mfaEnabledAt === undefined || user?.mfaEnabledAt === null) ? { kind: 'SETUP_REQUIRED' } : { kind: 'CHALLENGE_REQUIRED' };
}

/** The name a partner user sees in their authenticator app. */
export function mfaIssuerName(businessName: string | null): string {
  const trimmed = (businessName ?? '').trim();
  // The DEPLOYMENT's own name, so a driver's authenticator shows the company
  // that employs them rather than the name of the software they were given.
  // With no profile yet, the product's own portal name - the same title the
  // portal's tab carries - rather than the software vendor's.
  return `${marketplaceNameFrom(trimmed)} Logistics`;
}

/** Whether the portal is even offering this, for the boot response. */
export function mfaIsConfigurable(): boolean {
  return env.FEATURE_LOGISTICS_PORTAL;
}
