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
import { AppError, ErrorCode, forbidden, notFound, unauthorized } from '../../domain/errors.js';
import type { PermissionKey } from '../../domain/permissions.js';
import { safeCompare } from '../../infra/crypto.js';
import {
  loadAuthenticatedUser,
  type AuthenticatedUser,
  type UserKind,
} from '../../modules/identity/auth.service.js';
import { getSessionAuthState, verifyAccessToken } from '../../modules/identity/session.service.js';
import { assertAgreementsSatisfied, individualAgreementScope } from '../../modules/legal/agreement.service.js';
import {
  companyCapabilityBlock,
  type BuyerCompanyCapability,
} from '../../domain/buyer-company-state.js';
import {
  resetSessionToIndividual,
  resolveBuyerContext,
  type BuyerContext,
} from '../../modules/buyer-companies/context.service.js';

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
  // Three scopes, so a dispatcher signing into the carrier portal on the same
  // hostname does not sign a member of staff out of the console. The logistics
  // scope is abbreviated rather than spelled out only because a cookie name is
  // sent on every request; nothing depends on the spelling except this line.
  //
  // A fourth for the Audit Console, for the same reason: an inspector who also
  // shops here keeps two sessions, and neither can be read as the other.
  const scope =
    kind === 'ADMIN' ? 'admin' : kind === 'LOGISTICS' ? 'logi' : kind === 'AUDIT' ? 'audit' : 'shop';

  return {
    access: `uboss_${scope}_at`,
    refresh: `uboss_${scope}_rt`,
    csrf: `uboss_${scope}_csrf`,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after a guard has run. Never populated speculatively. */
    auth?: AuthenticatedUser & {
      sessionId: string;
      sessionHasLocation: boolean;
      /**
       * When this session passed its second-factor challenge, or null.
       *
       * Populated for every surface and acted on by exactly one: the logistics
       * guard. It is here rather than in that guard's own type so that
       * `currentUser` keeps one shape across all three audiences.
       */
      sessionMfaVerifiedAt: Date | null;
      sessionReauthenticatedAt: Date | null;
      /** Where this sign-in happened, ISO-3166-1 alpha-2. Null when unknown. */
      sessionCountry: string | null;
      /**
       * The same place as a person reads it - the geocoded name, or the
       * coordinates where no geocoder answered. Null when the browser has said
       * nothing. The panel shows it in the top bar.
       */
      sessionPlace: string | null;
      /**
       * When this session entered the Seller Hub's password, and for whom.
       *
       * Acted on by exactly one guard, the same way `sessionMfaVerifiedAt` is:
       * the seller guard refuses every Hub route while the member has a lock
       * this session has not opened.
       */
      sessionSellerUnlockedAt: Date | null;
      sessionSellerUnlockedForId: string | null;
      /** When the Seller Hub last saw deliberate activity; see the seller guard. */
      sessionSellerLastActivityAt: Date | null;
      /** What the session row asks for. Not an authority - see `buyerContext`. */
      sessionBuyerContextKind: 'INDIVIDUAL' | 'COMPANY' | null;
      sessionBuyerCompanyId: string | null;
      /**
       * Which buyer this request acts as, CONFIRMED against an active
       * membership by `requireCustomer` on this very request. Set only by the
       * customer guards; absent on admin and logistics requests.
       */
      buyerContext?: BuyerContext;
    };
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

/**
 * Where an access token came from.
 *
 * The SOURCE decides whether the CSRF check runs, so it is returned beside the
 * token rather than inferred afterwards. Inferring it from "is there an
 * Authorization header at all" was wrong in one specific way: a request
 * carrying `Authorization: Basic ...` - or any scheme that is not `Bearer` -
 * falls through to the cookie for authentication while looking header-shaped
 * to the CSRF decision, and the double-submit check is then skipped on a
 * cookie-authenticated state change. A browser cannot set that header
 * cross-site without a preflight the CORS allowlist refuses, so this was not
 * reachable from a page; it was one forgotten `allowedHeaders` entry, one
 * permissive proxy or one new client away from being reachable, and the fix
 * costs a field.
 */
interface ExtractedToken {
  token: string;
  source: 'cookie' | 'header';
}

function extractAccessToken(request: FastifyRequest, kind: UserKind): ExtractedToken | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return { token: header.slice(7), source: 'header' };
  }

  const cookie = request.cookies[cookieNamesFor(kind).access];
  return typeof cookie === 'string' && cookie.length > 0
    ? { token: cookie, source: 'cookie' }
    : null;
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
): Promise<
  AuthenticatedUser & {
    sessionId: string;
    sessionHasLocation: boolean;
    sessionMfaVerifiedAt: Date | null;
    sessionReauthenticatedAt: Date | null;
    sessionCountry: string | null;
    sessionPlace: string | null;
    sessionSellerUnlockedAt: Date | null;
    sessionSellerUnlockedForId: string | null;
    sessionSellerLastActivityAt: Date | null;
    sessionBuyerContextKind: 'INDIVIDUAL' | 'COMPANY' | null;
    sessionBuyerCompanyId: string | null;
  }
> {
  const presented = extractAccessToken(request, expectedKind);
  if (presented === null) {
    throw unauthorized(ErrorCode.UNAUTHENTICATED, 'Authentication is required.');
  }

  const usedCookie = presented.source === 'cookie';

  const claims = verifyAccessToken(presented.token);
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

  return {
    ...user,
    sessionId: claims.sid,
    sessionHasLocation: session.hasLocation,
    sessionMfaVerifiedAt: session.mfaVerifiedAt,
    sessionReauthenticatedAt: session.reauthenticatedAt,
    sessionCountry: session.country,
    sessionPlace: session.place,
    sessionSellerUnlockedAt: session.sellerUnlockedAt,
    sessionSellerUnlockedForId: session.sellerUnlockedForId,
    sessionSellerLastActivityAt: session.sellerLastActivityAt,
    sessionBuyerContextKind: session.buyerContextKind,
    sessionBuyerCompanyId: session.buyerCompanyId,
  };
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
    await adminGuardBody(request, permissions, { agreements: true });
  };
}

/**
 * Signed in to the console in full - temporary password replaced, two-step
 * code given, location shared - but not yet through the agreement screen.
 * For the agreement routes alone: they are how a member of staff gets through
 * it. No permission is needed to accept the staff terms.
 */
export function requireAdminBeforeAgreements() {
  return async function adminAgreementGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    await adminGuardBody(request, [], { agreements: false });
  };
}

async function adminGuardBody(
  request: FastifyRequest,
  permissions: PermissionKey[],
  options: { agreements: boolean },
): Promise<void> {
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

  /** Every administrator must enrol and challenge MFA for every session. */
  if (env.FEATURE_ADMIN_MFA && (!auth.mfaEnabled || auth.sessionMfaVerifiedAt === null)) {
    throw forbidden(
      ErrorCode.MFA_REQUIRED,
      auth.mfaEnabled
        ? 'Confirm your two-step code to continue.'
        : 'Set up two-step sign-in to continue.',
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

  /**
   * The staff terms and the Privacy Policy, accepted and acknowledged on the
   * console's agreement screen. Same shape as the gates above: `/me`,
   * `/logout` and the agreement routes use `requireAuthenticated`.
   */
  if (options.agreements) await assertAgreementsSatisfied(auth.id, 'STAFF');

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
}

/** Guard for customer routes. Authorization here is ownership, not permissions. */
export async function requireCustomer(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticateCustomer(request, { agreements: true });
}

/**
 * The same guard, without the agreement screen.
 *
 * For the few things a signed-in buyer must be able to do before accepting
 * the Terms and acknowledging the Privacy Policy, and there are exactly two
 * kinds: asking support for help, and exercising a privacy right. Somebody
 * who will not accept the Terms must still be able to ask for a copy of their
 * data, or for it to be erased, and to ask a person a question first.
 *
 * Its own export, like `requireSellerBeforeLock`, so every route that skips
 * the screen says so in its own registration and can be found with one search.
 */
export async function requireCustomerBeforeAgreements(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticateCustomer(request, { agreements: false });
}

/**
 * The Seller Hub's customer guard. A seller's own screen is the SELLER one,
 * checked by the seller guard after this; the buyer screen under it is the
 * individual one whatever the session's buyer context, so the company screen
 * never stands in front of the Seller Hub and the two flows stay apart.
 */
export async function requireCustomerForSellerHub(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticateCustomer(request, { agreements: true, individualScreen: true });
}

/**
 * The guard for a buyer's existing remedies: their orders, cancelling one,
 * tracking it, its documents, returns and refunds, and claims and complaints.
 *
 * Somebody shopping for themselves reaches these without the agreement
 * screen. New Terms are asked for prospectively; they never stand between a
 * consumer and an order already placed, a cancellation, a refund or a
 * complaint - the law gives those whatever the person has or has not
 * accepted since. Buying anything new still needs the screen: checkout, the
 * basket and every other route keep `requireCustomer`.
 *
 * Acting for a company is unchanged: the company screen still applies.
 */
export async function requireCustomerForRemedies(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticateCustomer(request, { agreements: true, remedies: true });
}

async function authenticateCustomer(
  request: FastifyRequest,
  options: { agreements: boolean; individualScreen?: boolean; remedies?: boolean },
): Promise<void> {
  const auth = await authenticate(request, 'CUSTOMER');

  // An ACTIVE customer user without a profile cannot own anything, so no
  // ownership check downstream could succeed. Fail here with a clear cause.
  if (auth.customerProfileId === null) {
    throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
  }

  assertCustomerSecondFactor(auth);

  // After the second factor: a session still owing its code is told that
  // first, and the agreement screen comes after signing in has finished.
  // Which screen depends on the CONFIRMED context - the membership, never the
  // sign-in tab - so the context is resolved first.
  const buyerContext = await confirmBuyerContext(auth);
  if (options.agreements) {
    if (options.individualScreen === true) {
      // The Seller Hub's buyer check is the one it always was: the consumer
      // screen is for shopping, and the seller's own screen comes after this.
      await assertAgreementsSatisfied(auth.id, 'BUYER');
    } else if (!(options.remedies === true && buyerContext.kind !== 'COMPANY')) {
      await assertBuyerAgreements(auth.id, buyerContext);
    }
  }

  request.auth = { ...auth, buyerContext };
}

/**
 * The agreement screen a storefront request answers to. Somebody acting for a
 * company owes the company screen (B2B Buyer Terms, Privacy Policy, B2B Buyer
 * Platform Services Agreement) for THAT company; somebody shopping for
 * themselves the consumer screen once its documents are in force
 * (`individualAgreementScope`), the buyer one until then.
 */
async function assertBuyerAgreements(userId: string, context: BuyerContext): Promise<void> {
  if (context.kind === 'COMPANY') await assertAgreementsSatisfied(userId, 'COMPANY_BUYER', context.companyId);
  else await assertAgreementsSatisfied(userId, await individualAgreementScope());
}

/**
 * A storefront session whose account has two-step sign-in switched on, and
 * which has not passed its code yet, may do nothing but finish signing in.
 *
 * The same shape as the console's gate in `requireAdmin`: the session is real
 * and useless until the challenge is passed. `/auth/me`, `/auth/mfa/*`,
 * `/auth/logout` and `/auth/language` use `requireAuthenticated`, which is why
 * they need no exception here. Optional for a buyer: only an account that
 * enrolled is ever challenged.
 */
export function assertCustomerSecondFactor(auth: {
  mfaEnabled: boolean;
  sessionMfaVerifiedAt: Date | null;
}): void {
  if (env.FEATURE_CUSTOMER_MFA && auth.mfaEnabled && auth.sessionMfaVerifiedAt === null) {
    throw forbidden(
      ErrorCode.MFA_CHALLENGE_REQUIRED,
      'Enter the code from your authenticator app to finish signing in.',
    );
  }
}

/**
 * Confirm the buyer context the session row asks for, on this request.
 *
 * INDIVIDUAL costs nothing. COMPANY costs one indexed read of the membership,
 * and it is paid on every request on purpose: the membership is the
 * authority, and a copy of it cached on the session would outlive the member
 * being removed.
 *
 * A session naming a company the person no longer belongs to is put back in
 * the individual context AND the request is refused. Refused rather than
 * quietly re-scoped, because somebody who pressed "place order" believing
 * they were buying for the company must not find it placed on their own
 * account instead.
 */
async function confirmBuyerContext(auth: {
  id: string;
  sessionId: string;
  sessionBuyerContextKind: 'INDIVIDUAL' | 'COMPANY' | null;
  sessionBuyerCompanyId: string | null;
}): Promise<BuyerContext> {
  const context = await resolveBuyerContext(auth.id, {
    buyerContextKind: auth.sessionBuyerContextKind,
    buyerCompanyId: auth.sessionBuyerCompanyId,
  });

  if (context === null) {
    await resetSessionToIndividual(auth.sessionId);
    throw forbidden(
      ErrorCode.BUYER_CONTEXT_INVALID,
      'You can no longer buy for that company. You are now shopping for yourself.',
    );
  }

  return context;
}

/**
 * The confirmed buyer context of a customer request. Individual on any
 * request whose guard did not set one, which is every non-customer route.
 */
export function buyerContextOf(request: FastifyRequest): BuyerContext {
  return request.auth?.buyerContext ?? { kind: 'INDIVIDUAL' };
}

/** The company this request acts for, or null for the person themselves. */
export function buyerCompanyIdOf(request: FastifyRequest): string | null {
  const context = buyerContextOf(request);
  return context.kind === 'COMPANY' ? context.companyId : null;
}

/**
 * Refuse unless this request may use `capability` in its buyer context.
 *
 * The individual context may do everything a customer could always do - that
 * is how existing behaviour is left exactly as it was. A company context is
 * judged by `companyCapabilityBlock`: the member's role first, then whether
 * the company is approved.
 *
 * `allowPending` is for the few things a member may do before approval that
 * still depend on role - building a basket, for one. It never lets a
 * pending company check out.
 */
export function assertBuyerCapability(
  request: FastifyRequest,
  capability: BuyerCompanyCapability,
  options: { allowPending?: boolean } = {},
): void {
  const context = buyerContextOf(request);
  if (context.kind === 'INDIVIDUAL') return;

  const block = companyCapabilityBlock(context.role, context.companyStatus, capability);

  if (block === 'ROLE') {
    throw forbidden(
      ErrorCode.BUYER_COMPANY_ROLE_FORBIDDEN,
      'Your role in this company does not allow that.',
    );
  }

  if (block === 'NOT_APPROVED' && options.allowPending !== true) {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.BUYER_COMPANY_NOT_APPROVED,
      message:
        'This company is not verified for purchasing yet. You can keep browsing and building your cart.',
      details: [
        {
          code: context.companyStatus,
          meta: { status: context.companyStatus, companyId: context.companyId },
        },
      ],
    });
  }
}

/**
 * The `where` fragment that keeps an order query inside this request's
 * buyer context.
 *
 * - Individual: the person's own orders that were not placed for a company.
 *   Their company orders are not shown here, and that is the isolation rule,
 *   not an oversight.
 * - Company, as a BUYER: the orders they placed for this company.
 * - Company, any other role: every order placed for this company. Those roles
 *   exist to oversee the company's purchasing.
 *
 * `placedByMe` narrows a company context to the caller's own orders, for the
 * actions only the person who placed an order may take (paying it,
 * cancelling it).
 */
export function orderScopeWhere(
  request: FastifyRequest,
  options: { placedByMe?: boolean } = {},
): { customerProfileId?: string; buyerCompanyId: string | null } {
  const auth = currentUser(request);
  const profileId = auth.customerProfileId ?? '';
  const context = buyerContextOf(request);

  if (context.kind === 'INDIVIDUAL') {
    return { customerProfileId: profileId, buyerCompanyId: null };
  }

  if (options.placedByMe === true || context.role === 'BUYER') {
    return { customerProfileId: profileId, buyerCompanyId: context.companyId };
  }

  return { buyerCompanyId: context.companyId };
}

/**
 * A customer session if there is one, and no objection if there is not.
 *
 * For the handful of routes that answer anybody but answer a signed-in
 * customer *better* — AI Mode is the one that exists today, where a guest may
 * ask the catalogue a question and a customer gets their history alongside it.
 *
 * The rule is: **no credential means guest; a credential means prove it.** A
 * request carrying no access token at all is simply anonymous. A request that
 * presents one is asking to be treated as that customer, so it goes through
 * the full check — expiry, revocation, surface, CSRF, account status — and a
 * failure is a failure rather than a quiet demotion. Swallowing those would
 * mean a customer whose session died silently became a stranger to their own
 * conversation, and it would let a cross-site POST that fails the CSRF check
 * carry on as a guest instead of being refused.
 *
 * Handlers therefore read `request.auth` as optional. `currentUser` is the
 * wrong accessor here — it throws — so use `request.auth` directly and branch.
 */
export async function optionalCustomer(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (extractAccessToken(request, 'CUSTOMER') === null) return;

  const auth = await authenticate(request, 'CUSTOMER');

  // Same reasoning as `requireCustomer`: a customer user with no profile
  // cannot own anything, so no ownership check downstream could succeed.
  if (auth.customerProfileId === null) {
    throw forbidden(ErrorCode.ACCOUNT_NOT_ACTIVATED, 'This account is not fully set up.');
  }

  // A credential means prove it, and a session still owing its two-step code
  // has not finished proving it - nor one that has not been through the
  // agreement screen.
  assertCustomerSecondFactor(auth);
  const buyerContext = await confirmBuyerContext(auth);
  await assertBuyerAgreements(auth.id, buyerContext);

  request.auth = { ...auth, buyerContext };
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
): AuthenticatedUser & {
  sessionId: string;
  sessionHasLocation: boolean;
  sessionMfaVerifiedAt: Date | null;
  sessionReauthenticatedAt: Date | null;
  sessionCountry: string | null;
  sessionPlace: string | null;
  sessionSellerUnlockedAt: Date | null;
  sessionSellerUnlockedForId: string | null;
  sessionSellerLastActivityAt: Date | null;
  sessionBuyerContextKind: 'INDIVIDUAL' | 'COMPANY' | null;
  sessionBuyerCompanyId: string | null;
  buyerContext?: BuyerContext;
} {
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
