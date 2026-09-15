/**
 * The seller guard.
 *
 * Every route under `/seller` passes through here, and what it does is the
 * whole tenant-isolation story in three lines: authenticate as a CUSTOMER using
 * the existing session machinery, resolve that person's seller membership from
 * their profile id, and hang it on the request. No route reads a seller id from
 * a parameter, a query string or a body - there is nowhere for one to come from
 * except the session.
 *
 * A seller is a CUSTOMER, not a third user type. That is deliberate and it is
 * what makes "become a seller" reuse the account somebody already has: the same
 * identity buys and sells, the same cookies carry it, and nobody is asked for a
 * second email address or a second verification. The Seller Hub is a different
 * set of ROUTES over the same identity, not a different identity.
 *
 * THE SECOND LOCK
 *
 * One identity, two passwords. The sign-in asks whether this is their account;
 * the Hub asks whether they are here to sell, and `assertSellerUnlocked` below
 * is where that second question is put. Buying and selling are two different
 * jobs with two different amounts of damage available, and sharing one password
 * between them means a browser left open on the shop is a browser left open on
 * the catalogue, the stock and the payouts.
 *
 * It is not a second factor and nothing here calls it one. It is a second
 * secret of the same kind, guarding a different set of routes.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import type { SellerPermissionKey } from '../../domain/seller-permissions.js';
import {
  assertSellerPermission,
  assertSellerTrading,
  resolveSellerMembership,
  type SellerMembership,
} from '../../modules/seller/account.service.js';
import { assertSellerUnlocked } from '../../modules/seller/lock.service.js';
import { currentUser, requireCustomer } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after `requireSeller` has run. Never populated speculatively. */
    seller?: SellerMembership;
  }
}

/**
 * Guard for seller routes.
 *
 * `permissions` is required rather than optional, on exactly the same reasoning
 * as `requireAdmin`: a seller route with no permission would be reachable by
 * every member of the organisation, including a Support Member hitting the
 * payout-setup endpoint. Passing an empty list is possible and is the
 * deliberate way to say "any member of this seller" - used by the routes that
 * only read the account's own summary.
 */
export function requireSeller(...permissions: SellerPermissionKey[]) {
  return async function sellerGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await requireCustomer(request, reply);

    const auth = currentUser(request);

    if (auth.customerProfileId === null) {
      throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
    }

    const membership = await resolveSellerMembership(auth.customerProfileId);

    /*
     * The second lock, before any permission is considered.
     *
     * Ordered that way deliberately: a locked session must be told to enter the
     * Hub password, not told that its role does not carry an action. The
     * remedies are different and a role refusal on a locked session sends
     * somebody to the wrong screen entirely.
     */
    assertSellerUnlocked(membership, {
      sellerUnlockedAt: auth.sessionSellerUnlockedAt,
      sellerUnlockedForId: auth.sessionSellerUnlockedForId,
    });

    for (const permission of permissions) {
      assertSellerPermission(membership, permission);
    }

    request.seller = membership;
  };
}

/**
 * The same guard, without the lock.
 *
 * For the handful of routes that have to work while the Hub is shut, and there
 * are exactly three kinds: the one that says what state the lock is in, the one
 * that chooses a password, and the one that enters it. A locked session that
 * could not reach those would have no way to become an unlocked one.
 *
 * Kept as its own export rather than an option on `requireSeller`, so that
 * every route which skips the lock says so in its own registration and can be
 * found with one search.
 */
export function requireSellerBeforeLock(...permissions: SellerPermissionKey[]) {
  return async function sellerLockGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await requireCustomer(request, reply);

    const auth = currentUser(request);

    if (auth.customerProfileId === null) {
      throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
    }

    const membership = await resolveSellerMembership(auth.customerProfileId);

    for (const permission of permissions) {
      assertSellerPermission(membership, permission);
    }

    request.seller = membership;
  };
}

/**
 * Guard for seller routes that additionally need an APPROVED account.
 *
 * Separate from the permission check because the two refuse for different
 * reasons and offer different remedies: an owner of a suspended account holds
 * every permission in the catalogue and still may not publish anything. Used on
 * everything that creates a listing, changes stock or touches an order.
 */
export function requireTradingSeller(...permissions: SellerPermissionKey[]) {
  const base = requireSeller(...permissions);

  return async function tradingSellerGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    await base(request, reply);
    assertSellerTrading(currentSeller(request));
  };
}

/**
 * Narrow `request.seller` after a guard has run.
 *
 * Throws rather than returning undefined, for the same reason `currentUser`
 * does: a handler reading the seller without having declared a guard is a
 * programming error, and returning undefined would turn it into a tenant leak
 * the first time somebody wrote `?.sellerAccountId ?? ''`.
 */
export function currentSeller(request: FastifyRequest): SellerMembership {
  if (request.seller === undefined) {
    throw forbidden(
      ErrorCode.SELLER_ACCOUNT_REQUIRED,
      'This account does not sell on the marketplace.',
    );
  }
  return request.seller;
}
