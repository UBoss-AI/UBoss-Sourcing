/**
 * The Seller Hub's own password.
 *
 * Selling keeps the account somebody already buys with — one email, one
 * identity, one order history — and puts a second lock in front of the Hub.
 * The two answer different questions and the product now answers them
 * separately: the sign-in asks "is this their account", this asks "are they
 * here to sell". A buyer who is handed a colleague's unlocked laptop can read
 * a basket; they cannot reprice a catalogue.
 *
 * WHY NOT A SECOND ACCOUNT
 *
 * Because `users.emailNormalized` is unique across all three audiences, a
 * second account would mean a second email address for one person, a second
 * verification, and one human appearing twice on the Companies screen. The
 * separation people actually want is between the two *jobs*, not between two
 * identities, and that is what a second password gives them.
 *
 * WHAT IS SEPARATE, EXACTLY
 *
 *   - Changing the shop password never touches this one, and the reverse.
 *   - The hash lives on `SellerMember`, so somebody selling for two businesses
 *     holds two locks and neither opens the other.
 *   - Opening it is recorded on the SESSION, not the account, the same way the
 *     second factor is: choosing a password once must not leave every later
 *     sign-in walking straight in.
 *
 * WHAT IT IS NOT
 *
 * It is not a second factor. It is a second secret of the same kind, and
 * nothing here claims otherwise — a second factor is something you have, and
 * saying "two-factor" about two passwords is a claim that only matters once,
 * in an incident, at which point it turns out to be false.
 */
import { ErrorCode, badRequest, forbidden } from '../../domain/errors.js';
import { hashPassword, verifyPassword } from '../../infra/crypto.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SellerMembership } from './account.service.js';

/** What the Hub needs to know before it draws anything. */
export interface SellerLockState {
  /** This person has chosen a Seller Hub password. */
  isSet: boolean;
  /** This session has entered it. */
  isOpen: boolean;
}

export function sellerLockState(
  membership: SellerMembership,
  session: { sellerUnlockedAt: Date | null; sellerUnlockedForId: string | null },
): SellerLockState {
  return {
    isSet: membership.hasLock,
    isOpen:
      session.sellerUnlockedAt !== null &&
      session.sellerUnlockedForId === membership.sellerAccountId,
  };
}

/**
 * Refuse unless this session has opened this seller's lock.
 *
 * Two refusals rather than one, because the two want different screens: a
 * member with no lock yet is offered a form to choose one, a member with a
 * lock is offered a form to enter it. A single "locked" would leave the Hub
 * guessing which to draw.
 */
export function assertSellerUnlocked(
  membership: SellerMembership,
  session: { sellerUnlockedAt: Date | null; sellerUnlockedForId: string | null },
): void {
  const state = sellerLockState(membership, session);

  if (!state.isSet) {
    throw forbidden(
      ErrorCode.SELLER_LOCK_NOT_SET,
      'Choose a Seller Hub password before you open the Hub.',
    );
  }

  if (!state.isOpen) {
    throw forbidden(
      ErrorCode.SELLER_LOCK_REQUIRED,
      'Enter your Seller Hub password to carry on.',
    );
  }
}

/**
 * Choose a Seller Hub password, or change it.
 *
 * Changing it demands the current one. Choosing the first one does not —
 * there is nothing to demand — and the act is already behind a signed-in
 * session that has passed the shop's own password, which is the same standing
 * "set your password" has everywhere else in this product.
 *
 * It must differ from the shop password. Two identical secrets are one secret
 * with two prompts, and a seller who reuses it has the separation they were
 * promised in name only.
 */
export async function setSellerLock(
  membership: SellerMembership,
  sessionId: string,
  userId: string,
  input: { currentPassword?: string | null; newPassword: string },
  correlationId?: string | null,
): Promise<SellerLockState> {
  const member = await prisma.sellerMember.findUnique({
    where: { id: membership.memberId },
    select: { passwordHash: true },
  });

  if (member === null) throw forbidden(ErrorCode.SELLER_ACCOUNT_REQUIRED, 'This account does not sell here.');

  if (member.passwordHash !== null) {
    const current = input.currentPassword ?? '';

    if (!(await verifyPassword(member.passwordHash, current))) {
      throw forbidden(ErrorCode.SELLER_LOCK_INVALID, 'That is not your current Seller Hub password.');
    }
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });

  // Null where the account has no shop password at all — an invited account
  // that has never been activated. There is nothing to be the same as.
  const shopPasswordHash = user?.passwordHash ?? null;

  if (
    shopPasswordHash !== null &&
    (await verifyPassword(shopPasswordHash, input.newPassword))
  ) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose a different password from the one you sign in to the shop with. Two identical passwords are one password.',
      [{ field: 'newPassword', code: 'SAME_AS_SHOP_PASSWORD' }],
    );
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  /*
   * Setting it opens it for THIS session and no other.
   *
   * One write, so a seller who has just chosen a password is not asked for it
   * a second time on the next click — and every other browser they are signed
   * in on is asked, which is the point of a lock.
   */
  await prisma.$transaction([
    prisma.sellerMember.update({
      where: { id: membership.memberId },
      data: { passwordHash, passwordSetAt: now },
    }),
    prisma.session.update({
      where: { id: sessionId },
      data: { sellerUnlockedAt: now, sellerUnlockedForId: membership.sellerAccountId },
    }),
    /*
     * Every OTHER session of this person loses its unlock.
     *
     * Changing the password is what somebody does when they think it is known,
     * so the sessions that might be holding it are exactly the ones that must
     * be asked again. Their shop sign-in is untouched: they keep their basket
     * and their order history, and the Hub asks for the new password.
     */
    prisma.session.updateMany({
      where: { userId, id: { not: sessionId }, sellerUnlockedForId: membership.sellerAccountId },
      data: { sellerUnlockedAt: null, sellerUnlockedForId: null },
    }),
  ]);

  await recordAudit({
    action: member.passwordHash === null ? AuditAction.SELLER_LOCK_SET : AuditAction.SELLER_LOCK_CHANGED,
    resourceType: 'SellerMember',
    resourceId: membership.memberId,
    actorType: 'CUSTOMER',
    actorUserId: userId,
    correlationId: correlationId ?? null,
  });

  return { isSet: true, isOpen: true };
}

/**
 * Open the lock for this session.
 *
 * The wrong password is `SELLER_LOCK_INVALID` and says so plainly. There is no
 * enumeration risk here to hedge against — the caller is already signed in as
 * this person — and a vague refusal on a screen somebody is staring at with
 * the right password in their hand is how they conclude the feature is broken.
 */
export async function unlockSeller(
  membership: SellerMembership,
  sessionId: string,
  userId: string,
  password: string,
  correlationId?: string | null,
): Promise<SellerLockState> {
  const member = await prisma.sellerMember.findUnique({
    where: { id: membership.memberId },
    select: { passwordHash: true },
  });

  if (member === null || member.passwordHash === null) {
    throw forbidden(
      ErrorCode.SELLER_LOCK_NOT_SET,
      'Choose a Seller Hub password before you open the Hub.',
    );
  }

  if (!(await verifyPassword(member.passwordHash, password))) {
    await recordAudit({
      action: AuditAction.SELLER_LOCK_REFUSED,
      resourceType: 'SellerMember',
      resourceId: membership.memberId,
      actorType: 'CUSTOMER',
      actorUserId: userId,
      correlationId: correlationId ?? null,
    });

    throw forbidden(ErrorCode.SELLER_LOCK_INVALID, 'That Seller Hub password is not right.');
  }

  await prisma.session.update({
    where: { id: sessionId },
    data: { sellerUnlockedAt: new Date(), sellerUnlockedForId: membership.sellerAccountId },
  });

  return { isSet: true, isOpen: true };
}

/**
 * Shut it again, for this session only.
 *
 * Offered because the Hub and the shop share a browser: somebody who has
 * finished packing orders and is handing the machine over should be able to
 * close the Hub without signing out of the shop and losing their basket.
 */
export async function lockSeller(sessionId: string): Promise<SellerLockState> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { sellerUnlockedAt: null, sellerUnlockedForId: null },
  });

  return { isSet: true, isOpen: false };
}
