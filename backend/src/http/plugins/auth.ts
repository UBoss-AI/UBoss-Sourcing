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
import { isSessionActive, verifyAccessToken } from '../../modules/identity/session.service.js';

export const ACCESS_COOKIE = 'uboss_at';
export const REFRESH_COOKIE = 'uboss_rt';
export const CSRF_COOKIE = 'uboss_csrf';
export const CSRF_HEADER = 'x-csrf-token';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after a guard has run. Never populated speculatively. */
    auth?: AuthenticatedUser & { sessionId: string };
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

function extractAccessToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }

  const cookie = request.cookies[ACCESS_COOKIE];
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check, applied only to cookie-authenticated state changes.
 *
 * A Bearer token cannot be attached by a browser to a cross-site request, so
 * that path needs no CSRF check. Cookies can be, so it does.
 */
function assertCsrf(request: FastifyRequest, usedCookie: boolean): void {
  if (!usedCookie) return;
  if (SAFE_METHODS.has(request.method)) return;

  const cookieValue = request.cookies[CSRF_COOKIE];
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
): Promise<AuthenticatedUser & { sessionId: string }> {
  const token = extractAccessToken(request);
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

  assertCsrf(request, usedCookie);

  // The token is stateless but the session is not: logout, deactivation and
  // password change revoke the session, and that must take effect immediately
  // rather than at the next token expiry.
  if (!(await isSessionActive(claims.sid))) {
    throw unauthorized(ErrorCode.SESSION_EXPIRED, 'Your session is no longer valid.');
  }

  const user = await loadAuthenticatedUser(claims.sub, expectedKind);
  if (user === null) {
    throw unauthorized(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is no longer active.');
  }

  return { ...user, sessionId: claims.sid };
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
export function currentUser(request: FastifyRequest): AuthenticatedUser & { sessionId: string } {
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
