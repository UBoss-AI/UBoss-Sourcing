/**
 * Self-registration - somebody opening their own account from the storefront.
 *
 * The other onboarding path, admin invitation, lives next door in
 * `customer.service.ts`. The difference that shapes every decision here is
 * that nobody has vouched for the person filling this form in. An invitation
 * is addressed to a mailbox a colleague chose; a registration is a stranger
 * typing an address they may not own, on behalf of a company we may not sell
 * to. So the account is created immediately but starts closed, and two gates
 * open it:
 *
 *   1. **The confirmation link.** Until it is opened the address is just a
 *      string. This is what stops somebody registering with a competitor's
 *      address, or a typo'd one that quietly swallows every later email.
 *   2. **A member of staff**, when `CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL`
 *      is on - which it is by default. Prices, purchasing limits and credit
 *      terms in this catalogue are per customer, so letting an unreviewed
 *      account buy is a commercial decision, not merely an inbox check.
 *
 * ## Why the response never says whether the address is already registered
 *
 * A sign-up form that answers "that email is taken" is an account-enumeration
 * oracle: anybody can walk a list of addresses through it and learn who buys
 * here, which for a B2B supplier is a customer list. So a duplicate takes the
 * *same* code path shape as a new account - same status code, same body, same
 * password hashing so the timing matches - and the only thing that differs
 * happens in the mailbox: the address itself gets an email saying an account
 * already exists and offering a password reset. Whoever filled the form in
 * learns nothing they did not already know.
 *
 * That mirrors what `/auth/password/forgot` already does, for the same reason.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { Role } from '../../domain/permissions.js';
import { hashPassword } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from '../identity/auth.service.js';
import { SUPPORTED_LANGUAGES } from '../identity/language.service.js';
import {
  buildTokenUrl,
  consumeEmailVerificationToken,
  issueToken,
} from '../identity/token.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import type { CustomerActor } from './customer.service.js';
import { selfRegistrationEnabled } from './customer.service.js';

/** Whether a confirmed registration still waits for a member of staff. */
export function registrationRequiresApproval(): boolean {
  return env.CUSTOMER_SELF_REGISTRATION_REQUIRES_APPROVAL;
}

export interface RegisterCustomerInput {
  fullName: string;
  email: string;
  /** Mobile number, as typed. Normalised before it is stored. */
  phone: string;
  /** ISO-3166-1 alpha-2. Decides which market's prices they are quoted in. */
  country: string;
  password: string;
  organization?: string | null;
  acceptedTerms: boolean;
  consentVersion: string;
  /** BCP-47 primary subtag the storefront is currently being read in. */
  language?: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface RegistrationOutcome {
  /**
   * Whether accounts on this deployment wait for staff after confirming.
   *
   * A property of the deployment, not of the account, so returning it tells a
   * caller nothing about whether an account was actually created - which is
   * what keeps the uniform response uniform.
   */
  requiresApproval: boolean;
}

/**
 * A mobile number as it will be stored.
 *
 * Spacing, brackets and dashes are how people write phone numbers and none of
 * them carry meaning, so they are stripped and the digits kept. A leading `+`
 * survives because it is the difference between an international number and a
 * local one. No attempt is made to validate the number against a country plan:
 * that needs a maintained dataset, gets it wrong at the edges, and the number
 * is verified in practice by someone ringing it.
 */
function normalisePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');

  if (digits.length < 6 || digits.length > 20) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a valid mobile number.', [
      { field: 'phone', code: 'INVALID_PHONE' },
    ]);
  }

  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** The country must be one this deployment actually serves. */
async function resolveCountry(code: string): Promise<{ code: string; currencyCode: string }> {
  const normalised = code.trim().toUpperCase();

  const country = await prisma.country.findFirst({
    where: { code: normalised, isActive: true },
    select: { code: true, currencyCode: true },
  });

  if (country === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a country we ship to.', [
      { field: 'country', code: 'COUNTRY_NOT_SUPPORTED' },
    ]);
  }

  return country;
}

/**
 * Open an account from the storefront's own sign-up form.
 *
 * Always resolves the same way whether or not the address was already taken -
 * see the note at the top of this file.
 */
export async function registerCustomer(input: RegisterCustomerInput): Promise<RegistrationOutcome> {
  if (!selfRegistrationEnabled()) {
    throw forbidden(
      ErrorCode.SELF_REGISTRATION_DISABLED,
      'Accounts are created by invitation. Please contact your account manager.',
    );
  }

  if (!input.acceptedTerms) {
    throw badRequest(
      ErrorCode.SCHEDULE_CONSENT_REQUIRED,
      'You must accept the terms to continue.',
      [{ field: 'acceptedTerms', code: 'CONSENT_REQUIRED' }],
    );
  }

  const emailNormalized = normaliseEmail(input.email);
  const phone = normalisePhone(input.phone);
  const country = await resolveCountry(input.country);
  const requiresApproval = registrationRequiresApproval();

  // Hashed before the duplicate check, and in the duplicate branch too. Argon2
  // dominates the response time of this endpoint, so skipping it for an
  // address that already exists would turn the clock into the enumeration
  // oracle the uniform response is there to prevent.
  const passwordHash = await hashPassword(input.password);

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true, email: true },
  });

  if (existing !== null) {
    // To the address itself, never back to the form. If the person at the
    // keyboard is not the account holder they learn nothing; if they are, this
    // is exactly the mail they needed.
    await enqueueNotification({
      eventKey: NotificationEvent.CUSTOMER_REGISTRATION_DUPLICATE,
      recipientEmail: existing.email,
      variables: {
        signInUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
        resetUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/forgot-password`,
      },
      relatedType: 'user',
      relatedId: existing.id,
      correlationId: input.correlationId ?? null,
    });

    await dispatchPendingNotifications();

    return { requiresApproval };
  }

  const customerRole = await prisma.role.findUnique({ where: { key: Role.CUSTOMER } });
  if (customerRole === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The customer role is missing. Run the seed to install roles and permissions.',
    );
  }

  // Only a language this build ships. It is written into `<html lang>` by both
  // frontends, so an unconstrained value would be arbitrary text in a page
  // attribute; null simply means "never chosen", and the storefront then
  // follows the browser.
  const language =
    input.language !== undefined &&
    input.language !== null &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(input.language)
      ? input.language
      : null;

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const userId = newId();
    const profileId = newId();

    await tx.user.create({
      data: {
        id: userId,
        type: 'CUSTOMER',
        email: input.email.trim(),
        emailNormalized,
        phone,
        passwordHash,
        // Closed until the link is opened. `emailVerifiedAt` is what tells the
        // two closed states apart - see `login` in auth.service.ts, which says
        // "confirm your email" or "waiting for approval" on the strength of it.
        status: 'PENDING_APPROVAL',
        emailVerifiedAt: null,
        preferredLanguage: language,
        // No `assignedById`: nobody assigned this role, the sign-up form did.
        roles: { create: { roleId: customerRole.id } },
      },
    });

    await tx.customerProfile.create({
      data: {
        id: profileId,
        userId,
        fullName: input.fullName.trim(),
        organization: input.organization?.trim() === '' ? null : (input.organization ?? null),
        phone,
        // The country answers the storefront's "where are you ordering from?"
        // prompt up front, so a shopper who has just typed it is not asked
        // again the moment they sign in.
        preferredCountry: country.code,
        preferredCurrency: country.currencyCode,
        localeChosenAt: now,
        consentAcceptedAt: now,
        consentVersion: input.consentVersion,
        // `invitedById`/`invitedAt` stay null on purpose: nobody invited them,
        // and that null is how the trail tells the two paths apart later.
        // `activatedAt` waits for the confirmation link.
      },
    });

    const verification = await issueToken(userId, 'EMAIL_VERIFICATION', null, tx);

    await enqueueNotification(
      {
        eventKey: NotificationEvent.CUSTOMER_EMAIL_VERIFICATION,
        recipientEmail: input.email.trim(),
        recipientName: input.fullName.trim(),
        variables: {
          verificationUrl: buildTokenUrl('EMAIL_VERIFICATION', verification.token, 'CUSTOMER'),
          expiresAt: verification.expiresAt.toISOString(),
        },
        dedupeKey: `email_verification:${userId}:${String(verification.expiresAt.getTime())}`,
        relatedType: 'user',
        relatedId: userId,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_REGISTERED,
        resourceType: 'customer',
        resourceId: profileId,
        actorType: 'CUSTOMER',
        actorUserId: userId,
        actorEmail: input.email.trim(),
        after: {
          fullName: input.fullName.trim(),
          country: country.code,
          requiresApproval,
        },
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );
  });

  // After commit, so the worker cannot read an outbox row that does not exist.
  await dispatchPendingNotifications();

  // Deliberately no id, no email, no "created: true". The duplicate branch above
  // returns the identical object, and anything account-specific here would put
  // the difference back on the wire.
  return { requiresApproval };
}

export interface VerifyRegistrationInput {
  token: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface VerifyRegistrationResult {
  email: string;
  /** ACTIVE means they can sign in now; PENDING_APPROVAL means staff are next. */
  status: 'ACTIVE' | 'PENDING_APPROVAL';
}

/**
 * Open the confirmation link.
 *
 * Where approval is not required this is the whole of onboarding: the account
 * goes ACTIVE and the storefront signs them straight in with the password they
 * chose. Where it is required this is the point the account becomes worth a
 * colleague's attention, which is why the console bell rings here rather than
 * at sign-up - an unconfirmed address is not yet a lead.
 */
export async function verifyRegistrationEmail(
  input: VerifyRegistrationInput,
): Promise<VerifyRegistrationResult> {
  const consumed = await consumeEmailVerificationToken(input.token);
  const requiresApproval = registrationRequiresApproval();
  const nextStatus = requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE';
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: consumed.userId },
      data: {
        emailVerifiedAt: now,
        status: nextStatus,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // `activatedAt` records that the holder has done everything asked of them -
    // password chosen, terms accepted, address proved. Whether staff have said
    // yes is a separate question, carried by `status`. Keeping them apart is
    // what lets an account suspended later be reactivated to ACTIVE rather
    // than being sent back to an invitation it never had.
    const profile = await tx.customerProfile.findUnique({
      where: { userId: consumed.userId },
      select: { id: true, fullName: true, phone: true, preferredCountry: true },
    });

    if (profile !== null) {
      await tx.customerProfile.update({
        where: { id: profile.id },
        data: { activatedAt: now },
      });

      await createAdminNotification(
        {
          kind: AdminNotificationKind.CUSTOMER_REGISTERED,
          variables: {
            fullName: profile.fullName,
            email: consumed.email,
            phone: profile.phone,
            country: profile.preferredCountry,
            requiresApproval,
          },
          linkPath: `/customers/${profile.id}`,
          requiredPermission: 'customer.read',
          relatedType: 'customer',
          relatedId: profile.id,
          dedupeKey: `customer_registered:${profile.id}`,
        },
        tx,
      );

      if (requiresApproval) {
        await enqueueNotification(
          {
            eventKey: NotificationEvent.CUSTOMER_REGISTRATION_PENDING,
            recipientEmail: consumed.email,
            recipientName: profile.fullName,
            dedupeKey: `registration_pending:${profile.id}`,
            relatedType: 'user',
            relatedId: consumed.userId,
            correlationId: input.correlationId ?? null,
          },
          tx,
        );
      }
    }

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_EMAIL_VERIFIED,
        resourceType: 'user',
        resourceId: consumed.userId,
        actorType: 'CUSTOMER',
        actorUserId: consumed.userId,
        actorEmail: consumed.email,
        after: { status: nextStatus },
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );
  });

  if (requiresApproval) await dispatchPendingNotifications();

  return { email: consumed.email, status: nextStatus };
}

/**
 * Send the confirmation link again.
 *
 * Uniform in exactly the way registration is: the caller is told nothing about
 * whether the address exists, or whether it is already confirmed. A new token
 * supersedes the outstanding one, so the older link stops working - which is
 * also why this cannot be used to keep an unlimited number of live links in
 * flight for one account.
 */
export async function resendVerificationEmail(
  email: string,
  context: { correlationId?: string | null } = {},
): Promise<void> {
  const emailNormalized = normaliseEmail(email);

  const user = await prisma.user.findUnique({
    where: { emailNormalized },
    select: {
      id: true,
      email: true,
      status: true,
      emailVerifiedAt: true,
      archivedAt: true,
      customerProfile: { select: { fullName: true } },
    },
  });

  const eligible =
    user !== null &&
    user.archivedAt === null &&
    user.emailVerifiedAt === null &&
    user.status === 'PENDING_APPROVAL' &&
    user.customerProfile !== null;

  if (!eligible) return;

  const issued = await issueToken(user.id, 'EMAIL_VERIFICATION');

  await enqueueNotification({
    eventKey: NotificationEvent.CUSTOMER_EMAIL_VERIFICATION,
    recipientEmail: user.email,
    recipientName: user.customerProfile?.fullName ?? null,
    variables: {
      verificationUrl: buildTokenUrl('EMAIL_VERIFICATION', issued.token, 'CUSTOMER'),
      expiresAt: issued.expiresAt.toISOString(),
    },
    dedupeKey: `email_verification:${user.id}:${String(issued.expiresAt.getTime())}`,
    relatedType: 'user',
    relatedId: user.id,
    correlationId: context.correlationId ?? null,
  });

  await dispatchPendingNotifications();
}

/**
 * A member of staff lets a self-registered account in.
 *
 * Refuses an account whose address is still unconfirmed. Approving one would
 * hand an ACTIVE account to whoever typed the address rather than to whoever
 * owns it, which is the single thing the confirmation link exists to stop -
 * and no amount of staff diligence at this screen can tell the two apart.
 */
export async function approveRegistration(
  customerProfileId: string,
  actor: CustomerActor,
): Promise<{ email: string }> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    include: {
      user: { select: { id: true, email: true, status: true, emailVerifiedAt: true } },
    },
  });

  if (profile === null) throw notFound('Customer');

  if (profile.user.status === 'ACTIVE') {
    throw conflict(ErrorCode.CONFLICT, 'This account is already active.');
  }

  if (profile.user.status !== 'PENDING_APPROVAL') {
    throw conflict(
      ErrorCode.CONFLICT,
      'This account is not awaiting approval. Only a self-registered account can be approved.',
    );
  }

  if (profile.user.emailVerifiedAt === null) {
    throw conflict(
      ErrorCode.EMAIL_NOT_VERIFIED,
      'This account has not confirmed its email address yet, so there is nothing to approve. ' +
        'Until it does, we have no evidence the address belongs to whoever filled the form in.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: profile.userId }, data: { status: 'ACTIVE' } });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.CUSTOMER_REGISTRATION_APPROVED,
        recipientEmail: profile.user.email,
        recipientName: profile.fullName,
        variables: {
          signInUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
        },
        dedupeKey: `registration_approved:${profile.id}`,
        relatedType: 'user',
        relatedId: profile.userId,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_APPROVED,
        resourceType: 'customer',
        resourceId: profile.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: profile.user.status },
        after: { status: 'ACTIVE' },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await dispatchPendingNotifications();

  return { email: profile.user.email };
}
