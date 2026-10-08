/**
 * The logistics guard.
 *
 * Every route under `/logistics` passes through here, and what it does is the
 * whole tenant-isolation story: authenticate as a LOGISTICS user using the
 * existing session machinery, resolve that person's partner membership from
 * their user id, check the second factor, and hang the membership on the
 * request. No route reads a partner id from a parameter, a query string or a
 * body - there is nowhere for one to come from except the session.
 *
 * WHY A LOGISTICS USER IS NOT A CUSTOMER
 *
 * A seller is a CUSTOMER, and `requireSeller` starts by calling
 * `requireCustomer`. That works because the same person buys and sells, and it
 * is what makes "become a seller" reuse a login somebody already has.
 *
 * A carrier's dispatcher is a different company's employee. They must never be
 * able to reach a cart, an order total, a price, a payment method or another
 * carrier's consignments, and the cheapest way to guarantee that is for their
 * credential not to be a customer credential at all. So `requireLogistics`
 * authenticates against the LOGISTICS surface, which has its own cookie jar,
 * its own audience claim and its own `users.type` - three independent checks,
 * any one of which refuses a token from the wrong application.
 *
 * THE MFA GATE
 *
 * Owners and administrators hold a role that can change who else is in the
 * company, so their sessions must pass a TOTP challenge before they may do
 * anything. Enforced HERE rather than only in the portal, for the same reason
 * the admin location gate is: a screen can be skipped by anybody talking to
 * the API directly, and a control that only exists in a frontend is a
 * suggestion.
 *
 * The three routes that stay reachable - `/auth/me`, `/auth/mfa/*` and
 * `/auth/logout` - use `requireLogisticsSession` rather than this guard, which
 * is exactly why they are not listed here as exceptions.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import type { LogisticsPermissionKey } from '../../domain/logistics-permissions.js';
import { evaluateMfaGate } from '../../modules/logistics/mfa.service.js';
import {
  assertLogisticsEnabled,
  assertLogisticsPermission,
  resolveLogisticsMembership,
  type LogisticsMembership,
} from '../../modules/logistics/partner.service.js';
import { assertAgreementsSatisfied } from '../../modules/legal/agreement.service.js';
import { currentUser, requireAuthenticated } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after a logistics guard has run. Never speculative. */
    logistics?: LogisticsMembership;
  }
}

/**
 * Authenticate as a logistics user and resolve their company, without the MFA
 * gate.
 *
 * Used by exactly three routes - the boot response, the MFA endpoints and
 * logout - because all three have to work for somebody who has not yet passed
 * a challenge. Nothing else should use it, and a route that does is a route
 * that is reachable with one factor.
 */
export async function requireLogisticsSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  assertLogisticsEnabled();

  await requireAuthenticated('LOGISTICS')(request, reply);

  const auth = currentUser(request);
  request.logistics = await resolveLogisticsMembership(auth.id);
}

/**
 * Guard for logistics routes.
 *
 * `permissions` is required rather than optional, on exactly the same
 * reasoning as `requireAdmin` and `requireSeller`: a route with no permission
 * would be reachable by every member of the organisation, including a
 * read-only tracking viewer hitting the status-update endpoint. Passing an
 * empty list is possible and is the deliberate way to say "any member of this
 * company", used by the routes that only read the company's own summary.
 *
 * All listed permissions are required, not any - the same rule `requireAdmin`
 * follows.
 */
export function requireLogistics(...permissions: LogisticsPermissionKey[]) {
  return async function logisticsGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const membership = await authenticateWithSecondFactor(request, reply);

    for (const permission of permissions) {
      assertLogisticsPermission(membership, permission);
    }
  };
}

/**
 * The same guard, without the agreement screen. For the portal's support
 * routes only: carrier staff who have not yet accepted the Logistics Partner
 * Terms must still be able to ask a person about them. Its own export so each
 * route that skips the screen says so where it is registered.
 */
export function requireLogisticsBeforeAgreements(...permissions: LogisticsPermissionKey[]) {
  return async function logisticsSupportGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const membership = await authenticateWithSecondFactor(request, reply, { agreements: false });

    for (const permission of permissions) {
      assertLogisticsPermission(membership, permission);
    }
  };
}

/**
 * Guard for the few routes that answer two kinds of caller: at least ONE of
 * the listed permissions is required, where `requireLogistics` requires all.
 *
 * It exists for the shipment page a DRIVER opens from their own round. Staff
 * reach it with `SHIPMENT_READ`; a driver holds `DRIVER_TASK_READ` instead,
 * and `assertShipmentAccess` then narrows them to the consignments on their
 * own round. So this guard only ever opens a door that the service behind it
 * narrows again - a route using it must call `assertShipmentAccess` (or a
 * service that does) before reading anything, and every one that does so
 * today says so in a comment above it.
 *
 * An empty list is refused, rather than meaning "any member": "any of
 * nothing" is a route nobody meant to write.
 */
export function requireLogisticsAny(...permissions: LogisticsPermissionKey[]) {
  if (permissions.length === 0) {
    throw new Error('requireLogisticsAny needs at least one permission.');
  }

  return async function logisticsAnyGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const membership = await authenticateWithSecondFactor(request, reply);

    if (!permissions.some((permission) => membership.permissions.has(permission))) {
      // The first key is the one named in the refusal: it is the staff key,
      // and the one a person asking an administrator would be granted.
      assertLogisticsPermission(membership, permissions[0] as LogisticsPermissionKey);
    }
  };
}

/** The session, the membership and the MFA gate: what every guard above does first. */
async function authenticateWithSecondFactor(
  request: FastifyRequest,
  reply: FastifyReply,
  options: { agreements: boolean } = { agreements: true },
): Promise<LogisticsMembership> {
  await requireLogisticsSession(request, reply);

  const membership = currentLogistics(request);
  const auth = currentUser(request);

  const gate = await evaluateMfaGate(membership, auth.sessionMfaVerifiedAt);

  if (gate.kind === 'SETUP_REQUIRED') {
    throw forbidden(
      ErrorCode.LOGISTICS_MFA_SETUP_REQUIRED,
      'Set up two-step sign-in before using the portal. Your role can change who else has access.',
    );
  }

  if (gate.kind === 'CHALLENGE_REQUIRED') {
    throw forbidden(
      ErrorCode.LOGISTICS_MFA_CHALLENGE_REQUIRED,
      'Enter the code from your authenticator to continue.',
    );
  }

  // The Logistics Partner Terms and the Privacy Policy, after the second
  // factor: the agreement screen comes once signing in has finished.
  if (options.agreements) await assertAgreementsSatisfied(auth.id, 'LOGISTICS');

  return membership;
}

/**
 * Narrow `request.logistics` after a guard has run.
 *
 * Throws rather than returning undefined, for the same reason `currentUser`
 * and `currentSeller` do: a handler reading the membership without having
 * declared a guard is a programming error, and returning undefined would turn
 * it into a tenant leak the first time somebody wrote
 * `?.logisticsPartnerId ?? ''`.
 */
export function currentLogistics(request: FastifyRequest): LogisticsMembership {
  if (request.logistics === undefined) {
    throw forbidden(
      ErrorCode.LOGISTICS_PARTNER_REQUIRED,
      'This account is not attached to a logistics company.',
    );
  }
  return request.logistics;
}

/**
 * The caller as the masking rules see them, for one shipment.
 *
 * Built here rather than in each handler so that "is this the assigned driver"
 * is answered one way everywhere. `isAssignedDriver` is the only thing that
 * unmasks a telephone number on an ordinary read, so the question is worth
 * exactly one implementation.
 */
export function contactViewerFor(
  membership: LogisticsMembership,
  assignedDriverProfileId: string | null,
): { permissions: ReadonlySet<LogisticsPermissionKey>; isAssignedDriver: boolean } {
  return {
    permissions: membership.permissions,
    isAssignedDriver:
      membership.driverProfileId !== null &&
      assignedDriverProfileId !== null &&
      membership.driverProfileId === assignedDriverProfileId,
  };
}
