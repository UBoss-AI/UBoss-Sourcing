/**
 * Authentication and authorization guards.
 *
 * Deny-by-default: a route is unreachable unless it declares a guard. There is
 * no "authenticated therefore allowed" path - `requireAdmin` still needs an
 * explicit permission, and customer routes still check record ownership.
 *
 * Tokens travel in httpOnly cookies (the frontends never touch them in JS) with
 * a Bearer fallback for server-to-server and API-client use. Cookie requests
 * additionally carry CSRF protection via a double-submit token.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden, notFound, unauthorized } from '../../domain/errors.js';
import type { PermissionKey } from '../../domain/permissions.js';
import { safeCompare } from '../../infra/crypto.js';
import {
  loadAuthenticatedUser,
  type AuthenticatedUser,
  type UserKind,
} from '../../modules/identity/auth.service.js';
import { getSessionAuthState, verifyAccessToken } from '../../modules/identity/session.service.js';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie names, scoped to the surface they belong to.
 *
 * A cookie's identity is its name plus domain and path - the PORT is not part
 * of it (RFC 6265). So the admin panel and the storefront share one jar
 * whenever they sit on the same hostname, which is every local setup and any
 * deployment that does not give them separate subdomains.
 *
 * With one set of names, signing into one surface overwrote the other's
 * tokens and silently signed that person out. Naming them apart is what keeps
 * a staff member and a customer signed in at the same time in one browser.
 *
 * The names are derived from the audience the route was registered for, not
 * from anything in the request, so a caller cannot choose which jar to read.
 */
export interface CookieNames {
  access: string;
  refresh: string;
  csrf: string;
}

export function cookieNamesFor(kind: UserKind): CookieNames {
  const scope = kind === 'ADMIN' ? 'admin' : 'shop';

  return {
    access: `uboss_${scope}_at`,
    refresh: `uboss_${scope}_rt`,
    csrf: `uboss_${scope}_csrf`,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after a guard has run. Never populated speculatively. */
    auth?: AuthenticatedUser & { sessionId: string; sessionHasLocation: boolean };
  }
}

/** Cookie options shared by every auth cookie. */
export function authCookieOptions(maxAgeSeconds: number): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
  domain?: string;
} {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    maxAge: maxAgeSeconds,
    ...(env.COOKIE_DOMAIN.length > 0 ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/**
 * The CSRF cookie is the one auth cookie readable by JavaScript - the frontend
 * must copy it into the request header for the double-submit check to work.
 * It carries no authority on its own.
 */
export function csrfCookieOptions(maxAgeSeconds: number): ReturnType<typeof authCookieOptions> {
  return { ...authCookieOptions(maxAgeSeconds), httpOnly: false };
}

function extractAccessToken(request: FastifyRequest, kind: UserKind): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }

  const cookie = request.cookies[cookieNamesFor(kind).access];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check, applied only to cookie-authenticated state changes.
 *
 * A Bearer token cannot be attached by a browser to a cross-site request, so
 * that path needs no CSRF check. Cookies can be, so it does.
 */
function assertCsrf(request: FastifyRequest, usedCookie: boolean, kind: UserKind): void {
  if (!usedCookie) return;
  if (SAFE_METHODS.has(request.method)) return;

  const cookieValue = request.cookies[cookieNamesFor(kind).csrf];
  const headerValue = request.headers[CSRF_HEADER];

  if (
    typeof cookieValue !== 'string' ||
    typeof headerValue !== 'string' ||
    cookieValue.length === 0 ||
    !safeCompare(cookieValue, headerValue)
  ) {
    throw forbidden(ErrorCode.FORBIDDEN, 'CSRF validation failed. Refresh the page and try again.');
  }
}

/**
 * Resolve the caller for the given surface.
 *
 * `expectedKind` is checked twice - once against the token claim and once
 * against the database row - so an access token minted for the customer site
 * cannot reach an admin route even if the signing key were shared.
 */
async function authenticate(
  request: FastifyRequest,
  expectedKind: UserKind,
): Promise<AuthenticatedUser & { sessionId: string; sessionHasLocation: boolean }> {
  const token = extractAccessToken(request, expectedKind);
  if (token === null) {
    throw unauthorized(ErrorCode.UNAUTHENTICATED, 'Authentication is required.');
  }

  const usedCookie = request.headers.authorization === undefined;

  const claims = verifyAccessToken(token);
  if (claims === null) {
    throw unauthorized(ErrorCode.SESSION_EXPIRED, 'Your session has expired. Please sign in again.');
  }

  if (claims.typ !== expectedKind) {
    throw forbidden(ErrorCode.FORBIDDEN, 'This credential is not valid for this application.');
  }

  assertCsrf(request, usedCookie, expectedKind);

  // The token is stateless but the session is not: logout, deactivation and
  // password change revoke the session, and that must take effect immediately
  // rather than at the next token expiry.
  //
  // The same read answers whether the session has said where it is, so the
  // location gate below costs no extra query.
  const session = await getSessionAuthState(claims.sid);
  if (!session.isActive) {
    throw unauthorized(ErrorCode.SESSION_EXPIRED, 'Your session is no longer valid.');
  }

  const user = await loadAuthenticatedUser(claims.sub, expectedKind);
  if (user === null) {
    throw unauthorized(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is no longer active.');
  }

  return { ...user, sessionId: claims.sid, sessionHasLocation: session.hasLocation };
}

/**
 * Does this admin session still owe us a position?
 *
 * False whenever the deployment has the feature off - an installation served
 * over plain HTTP has no Geolocation API to satisfy the gate with, and locking
 * every member of staff out of their own panel is not a security posture.
 */
export function isLocationPending(auth: { type: UserKind; sessionHasLocation: boolean }): boolean {
  return env.FEATURE_ADMIN_LOGIN_LOCATION && auth.type === 'ADMIN' && !auth.sessionHasLocation;
}

/**
 * Guard for admin routes.
 *
 * `permissions` is required rather than optional on purpose: an admin route
 * with no permission would be reachable by every staff member, including a
 * Catalog Manager hitting a refund endpoint.
 */
export function requireAdmin(...permissions: PermissionKey[]) {
  return async function adminGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const auth = await authenticate(request, 'ADMIN');

    /**
     * An account still on its emailed temporary password can hold a session and
     * nothing else. This is the control, not the screen the Admin Panel shows:
     * that password travelled in plaintext and may have been read by anyone with
     * access to the inbox, so it must not be able to touch an order, a price or
     * another staff account even once.
     *
     * The three routes that stay reachable - `/me`, `/password/change` and
     * `/logout` - use `requireAuthenticated` rather than this guard, which is
     * exactly why they are not listed here as exceptions.
     */
    if (auth.mustChangePassword) {
      throw forbidden(
        ErrorCode.PASSWORD_CHANGE_REQUIRED,
        'Set your own password before using the admin panel.',
      );
    }

    /**
     * Signed in, but the browser has not yet said where from.
     *
     * Enforced here rather than only in the panel for the same reason as the
     * line above: a screen can be skipped by anyone talking to the API
     * directly, and a control that only exists in the frontend is a suggestion.
     * The three routes that stay open - `/me`, `/logout` and
     * `/session/location` itself - use `requireAuthenticated`, which is why
     * they need no exception here.
     */
    if (isLocationPending(auth)) {
      throw forbidden(
        ErrorCode.LOCATION_REQUIRED,
        'Allow location access to continue. The admin panel records where each sign-in happened.',
      );
    }

    const held = new Set(auth.permissions);

    // All listed permissions are required, not any.
    const missing = permissions.filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to perform this action.',
      );
    }

    request.auth = auth;
  };
}

/** Guard for customer routes. Authorization here is ownership, not permissions. */
export async function requireCustomer(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const auth = await authenticate(request, 'CUSTOMER');

  // An ACTIVE customer user without a profile cannot own anything, so no
  // ownership check downstream could succeed. Fail here with a clear cause.
  if (auth.customerProfileId === null) {
    throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
  }

  request.auth = auth;
}

/** Any authenticated principal, either surface. For profile and logout routes. */
export function requireAuthenticated(kind: UserKind) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    request.auth = await authenticate(request, kind);
  };
}

/** Narrow `request.auth` after a guard has run. Throws rather than returning undefined. */
export function currentUser(
  request: FastifyRequest,
): AuthenticatedUser & { sessionId: string; sessionHasLocation: boolean } {
  if (request.auth === undefined) {
    // A programming error - a handler read auth without declaring a guard.
    throw unauthorized(ErrorCode.UNAUTHENTICATED, 'Authentication is required.');
  }
  return request.auth;
}

/**
 * Resource ownership.
 *
 * The rule from SOP 3: a customer must never read another customer's order,
 * address, schedule or payment. Called with the owning profile id of whatever
 * row was just loaded.
 *
 * Returns 404, not 403: confirming that a record exists but belongs to someone
 * else still leaks its existence, and order ids are guessable enough to matter.
 */
export function assertOwnership(
  request: FastifyRequest,
  ownerProfileId: string | null,
  resourceLabel: string,
): void {
  const auth = currentUser(request);

  // Admins bypass ownership; their own permission check already ran.
  if (auth.type === 'ADMIN') return;

  if (ownerProfileId === null || auth.customerProfileId !== ownerProfileId) {
    throw notFound(resourceLabel);
  }
}
