/**
 * Changing the two things that identify an account: its email address and its
 * telephone number.
 *
 * The whole reason this is a module rather than two lines in a PATCH handler is
 * one rule: **an unconfirmed value never becomes the live one.**
 *
 * `users.email` is what the account signs in with, and what every order
 * confirmation, payment link, invoice and password reset is sent to. Writing a
 * typed string straight into it means one typo locks somebody out of their own
 * purchasing account with no way back — the confirmation would go to the
 * address that does not exist. So a requested address is parked in
 * `users.pendingEmail`, a single-use link is minted to it, and only consuming
 * that link promotes it. The account carries on working normally throughout.
 *
 * Two emails go out per request, and the second one is the point:
 *
 *   - The **new** address gets the link. Owning that mailbox is the only thing
 *     the link proves, so it is the only place it is sent.
 *   - The **old** address gets a warning with no link. If somebody else has
 *     got into the account, this is the message that reaches the real holder
 *     while their address still works, and it tells them how to stop it —
 *     changing the password revokes every session and supersedes the pending
 *     change.
 *
 * A telephone number follows the same shape with one honest difference,
 * recorded here and on `users.pendingPhone` because it is the kind of thing
 * that gets quietly forgotten: **the code for a number is delivered by email,
 * not by SMS.** `NotificationChannel` names SMS and nothing in this
 * installation sends it. Confirming by email proves control of the *account*,
 * which is what stops somebody else changing the number; it does not prove
 * control of the number. Wiring an SMS provider is what upgrades that, and the
 * only thing that has to change is where the message is sent.
 *
 * Uniqueness is checked twice, at request and again at confirmation. Minutes
 * pass between the two, and in that time another account can register or
 * confirm the same address. Checking only once is how two accounts end up
 * sharing a sign-in identity.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { revokeAllUserSessions } from '../identity/session.service.js';
import {
  buildTokenUrl,
  consumeContactChangeToken,
  issueToken,
} from '../identity/token.service.js';
import type { CustomerActor } from './customer.service.js';

/** What is in flight, for the profile screen to render. */
export interface PendingContactChange {
  /** The address awaiting confirmation, or null. */
  email: string | null;
  /** The number awaiting confirmation, or null. */
  phone: string | null;
}

function storefrontUrl(path: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}${path}`;
}

/**
 * Is this address free?
 *
 * Free means: no other account signs in with it, and no other account is
 * already moving to it. The requester's own row is excluded from both — asking
 * to move to the address you are already moving to is a resend, not a clash.
 *
 * The answer is deliberately the same for both cases and the caller words it
 * without saying which. A message that distinguished "already registered" from
 * "already requested" would turn this endpoint into an oracle for whether a
 * given company buys here, which is a question a competitor would like
 * answered and the account holder does not need answered.
 */
async function addressIsFree(userId: string, normalized: string): Promise<boolean> {
  const [owner, claimant] = await Promise.all([
    prisma.user.findFirst({
      where: { emailNormalized: normalized, id: { not: userId } },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { pendingEmailNormalized: normalized, id: { not: userId } },
      select: { id: true },
    }),
  ]);

  return owner === null && claimant === null;
}

export async function getPendingContactChange(userId: string): Promise<PendingContactChange> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingEmail: true, pendingPhone: true },
  });

  if (user === null) throw notFound('Account');

  return { email: user.pendingEmail, phone: user.pendingPhone };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export async function requestEmailChange(
  userId: string,
  newEmail: string,
  actor: CustomerActor,
): Promise<{ expiresAt: Date }> {
  const email = newEmail.trim();
  const normalized = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailNormalized: true, customerProfile: { select: { fullName: true } } },
  });

  if (user === null) throw notFound('Account');

  if (normalized === user.emailNormalized) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That is already the address on this account.',
      [{ field: 'email' }],
    );
  }

  if (!(await addressIsFree(userId, normalized))) {
    throw conflict(
      ErrorCode.EMAIL_ALREADY_IN_USE,
      'That address cannot be used for this account. Try a different one.',
      [{ field: 'email' }],
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { pendingEmail: email, pendingEmailNormalized: normalized },
  });

  // Issued after the park, not before: a token live against a row with no
  // pending address would confirm nothing and would still count as a spent
  // link. `issueToken` supersedes any outstanding EMAIL_CHANGE token, so a
  // second request invalidates the first link rather than leaving two live.
  const issued = await issueToken(userId, 'EMAIL_CHANGE', userId);
  const recipientName = user.customerProfile?.fullName ?? null;

  await enqueueNotification({
    eventKey: NotificationEvent.USER_EMAIL_CHANGE_CONFIRM,
    recipientEmail: email,
    recipientName,
    variables: {
      confirmUrl: buildTokenUrl('EMAIL_CHANGE', issued.token, 'CUSTOMER'),
      expiresAt: issued.expiresAt.toISOString(),
      currentEmail: user.email,
    },
    relatedType: 'user',
    relatedId: userId,
    correlationId: actor.correlationId ?? null,
  });

  // The warning to the address the account still uses. See the header.
  await enqueueNotification({
    eventKey: NotificationEvent.USER_EMAIL_CHANGE_REQUESTED,
    recipientEmail: user.email,
    recipientName,
    variables: {
      pendingEmail: email,
      passwordUrl: storefrontUrl('/forgot-password'),
    },
    relatedType: 'user',
    relatedId: userId,
    correlationId: actor.correlationId ?? null,
  });

  await dispatchPendingNotifications();

  await recordAudit({
    action: AuditAction.CUSTOMER_UPDATED,
    resourceType: 'user',
    resourceId: userId,
    actorType: 'CUSTOMER',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    // The addresses themselves, because "who moved this account and to where"
    // is the question asked after a takeover. Never the token.
    before: { email: user.email },
    after: { pendingEmail: email },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { expiresAt: issued.expiresAt };
}

/**
 * Promote the pending address.
 *
 * Everything after the token is consumed happens in one transaction: an
 * account whose email moved but whose sessions were not revoked, or whose
 * pending value was left behind, is worse than either outcome.
 *
 * `expectedUserId` is the session's own id. The token already identifies the
 * account, so this is defence in depth rather than the check — but a link
 * opened while signed in as somebody else should refuse rather than quietly
 * change the other account.
 */
export async function confirmEmailChange(
  token: string,
  expectedUserId: string,
  actor: CustomerActor,
): Promise<{ email: string }> {
  const consumed = await consumeContactChangeToken(token, 'EMAIL_CHANGE');

  if (consumed.userId !== expectedUserId) {
    throw badRequest(ErrorCode.TOKEN_INVALID, 'This link is not valid for the signed-in account.');
  }

  const user = await prisma.user.findUnique({
    where: { id: consumed.userId },
    select: { id: true, email: true, pendingEmail: true, pendingEmailNormalized: true },
  });

  if (user === null) throw notFound('Account');

  if (user.pendingEmail === null || user.pendingEmailNormalized === null) {
    throw badRequest(
      ErrorCode.CONTACT_CHANGE_NOT_PENDING,
      'There is no email change waiting to be confirmed.',
    );
  }

  // Asked again. Minutes have passed, and in that time another account can
  // have registered or confirmed this address.
  if (!(await addressIsFree(user.id, user.pendingEmailNormalized))) {
    // The pending value is cleared as well: leaving it would offer the same
    // refusal on every future attempt with no way for the customer to see why.
    await prisma.user.update({
      where: { id: user.id },
      data: { pendingEmail: null, pendingEmailNormalized: null },
    });

    throw conflict(
      ErrorCode.EMAIL_ALREADY_IN_USE,
      'That address cannot be used for this account. Try a different one.',
    );
  }

  const previous = user.email;
  // Read out of the row before the transaction rather than off `user` inside
  // it: the null checks above narrowed these, and TypeScript loses that
  // narrowing across the closure boundary.
  const next = user.pendingEmail;
  const nextNormalized = user.pendingEmailNormalized;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        email: next,
        emailNormalized: nextNormalized,
        // Confirmed by definition: the link went to this address and came
        // back. Anything else would leave an account unable to sign in for
        // want of a verification it has just completed.
        emailVerifiedAt: new Date(),
        pendingEmail: null,
        pendingEmailNormalized: null,
      },
    });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_UPDATED,
        resourceType: 'user',
        resourceId: user.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { email: previous },
        after: { email: next },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  /*
   * Every session goes, including the one that just confirmed.
   *
   * The address is the sign-in identity, and an access token minted against
   * the old one is a credential for an account that no longer exists under
   * that name. Signing in again with the new address is a small cost; a live
   * session on a stale identity is the kind of thing that is only noticed
   * after it has been used.
   */
  await revokeAllUserSessions(user.id, 'email-changed');

  return { email: next };
}

/** Abandon a change. Consuming the outstanding token is what kills the link. */
export async function cancelEmailChange(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingEmail: null, pendingEmailNormalized: null },
    });

    // Marked consumed rather than deleted, like everywhere else in
    // `token.service.ts`: the trail of who was sent what survives.
    await tx.authToken.updateMany({
      where: { userId, type: 'EMAIL_CHANGE', consumedAt: null },
      data: { consumedAt: new Date() },
    });
  });
}

// ---------------------------------------------------------------------------
// Telephone
// ---------------------------------------------------------------------------

export async function requestPhoneChange(
  userId: string,
  newPhone: string,
  actor: CustomerActor,
): Promise<{ expiresAt: Date }> {
  const phone = newPhone.trim();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, customerProfile: { select: { fullName: true } } },
  });

  if (user === null) throw notFound('Account');

  await prisma.user.update({ where: { id: userId }, data: { pendingPhone: phone } });

  const issued = await issueToken(userId, 'PHONE_CHANGE', userId);

  await enqueueNotification({
    eventKey: NotificationEvent.USER_PHONE_CHANGE_CONFIRM,
    // The account's email, not the number. See the header.
    recipientEmail: user.email,
    recipientName: user.customerProfile?.fullName ?? null,
    variables: {
      confirmUrl: buildTokenUrl('PHONE_CHANGE', issued.token, 'CUSTOMER'),
      expiresAt: issued.expiresAt.toISOString(),
      pendingPhone: phone,
    },
    relatedType: 'user',
    relatedId: userId,
    correlationId: actor.correlationId ?? null,
  });

  await dispatchPendingNotifications();

  return { expiresAt: issued.expiresAt };
}

export async function confirmPhoneChange(
  token: string,
  expectedUserId: string,
  actor: CustomerActor,
): Promise<{ phone: string }> {
  const consumed = await consumeContactChangeToken(token, 'PHONE_CHANGE');

  if (consumed.userId !== expectedUserId) {
    throw badRequest(ErrorCode.TOKEN_INVALID, 'This link is not valid for the signed-in account.');
  }

  const user = await prisma.user.findUnique({
    where: { id: consumed.userId },
    select: { id: true, phone: true, pendingPhone: true, customerProfile: { select: { id: true } } },
  });

  if (user === null) throw notFound('Account');

  if (user.pendingPhone === null) {
    throw badRequest(
      ErrorCode.CONTACT_CHANGE_NOT_PENDING,
      'There is no telephone number waiting to be confirmed.',
    );
  }

  const next = user.pendingPhone;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { phone: next, phoneVerifiedAt: new Date(), pendingPhone: null },
    });

    /*
     * The profile's copy moves with it.
     *
     * `customer_profiles.phone` is the number an order and a delivery note
     * carry, and `users.phone` is the one on the identity. They are two
     * columns for one fact and both existed before this screen did; a change
     * that updated one of them would leave a courier ringing the old number.
     */
    if (user.customerProfile !== null) {
      await tx.customerProfile.update({
        where: { id: user.customerProfile.id },
        data: { phone: next },
      });
    }

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_UPDATED,
        resourceType: 'user',
        resourceId: user.id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { phone: user.phone },
        after: { phone: next },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // No session revocation. Unlike the address, a telephone number is not the
  // sign-in identity, so nothing about the live sessions has gone stale.
  return { phone: next };
}

export async function cancelPhoneChange(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { pendingPhone: null } });

    await tx.authToken.updateMany({
      where: { userId, type: 'PHONE_CHANGE', consumedAt: null },
      data: { consumedAt: new Date() },
    });
  });
}
