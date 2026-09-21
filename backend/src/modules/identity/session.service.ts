/**
 * Sessions and refresh-token rotation.
 *
 * The model is a rotating refresh token family:
 *
 *   - Every refresh issues a NEW token and revokes the old one, chained by
 *     `replacedBySessionId` within a shared `familyId`.
 *   - Only the SHA-256 of a token is stored, so a database dump yields nothing
 *     usable.
 *   - Presenting an already-rotated token means the token leaked (an attacker
 *     replaying it, or the legitimate client racing a stolen copy). The whole
 *     family is revoked immediately - both parties are logged out, which is the
 *     correct outcome when you cannot tell which one is the thief.
 *
 * Access tokens are short-lived and stateless; the refresh token is the thing
 * with real authority, which is why it carries all the machinery.
 */
import { createHmac } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, unauthorized } from '../../domain/errors.js';
import { generateToken, safeCompare, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
// The label a position is read as. Shared with the notification the sign-in
// rings so the bell and the top bar cannot word the same place differently.
import { formatCoordinates } from './session-location.service.js';
import type { UserKind } from './auth.service.js';

/**
 * The audiences a token may be minted for, as a runtime set.
 *
 * `UserKind` is a type and disappears at compile time; `verifyAccessToken`
 * needs to reject an unrecognised value in a token somebody supplied. Kept
 * beside the type it mirrors so adding a fourth surface fails loudly here
 * rather than quietly letting one through.
 */
const USER_KINDS: ReadonlySet<string> = new Set<UserKind>(['ADMIN', 'CUSTOMER', 'LOGISTICS']);

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id, so a revoked session invalidates its access tokens too. */
  sid: string;
  /**
   * Which application this token was minted for. The three contexts never
   * interchange: the guard compares this against the route's own audience AND
   * against `users.type`, so a token cannot be replayed at another surface
   * even though the signing key is shared.
   */
  typ: UserKind;
  iat: number;
  exp: number;
}

export interface SessionContext {
  userAgent?: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

// --- Access tokens ---------------------------------------------------------
//
// A compact signed token (HMAC-SHA256 over base64url segments) rather than a
// JWT library: the claim set is fixed and tiny, and hand-rolling the verify
// path keeps `alg: none` and algorithm-confusion attacks structurally
// impossible - there is no algorithm field to confuse.

function base64urlEncode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signAccessToken(claims: AccessTokenClaims): string {
  const payload = base64urlEncode(claims);
  const signature = createHmac('sha256', env.ACCESS_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify and decode an access token. Returns null for anything untrustworthy -
 * callers turn that into a 401 without distinguishing the reason, so a probe
 * cannot learn whether a token was forged or merely expired.
 */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  if (payload === undefined || signature === undefined) return null;

  const expected = createHmac('sha256', env.ACCESS_TOKEN_SECRET).update(payload).digest('base64url');
  if (!safeCompare(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;

    if (
      typeof claims !== 'object' ||
      claims === null ||
      typeof (claims as AccessTokenClaims).sub !== 'string' ||
      typeof (claims as AccessTokenClaims).sid !== 'string' ||
      typeof (claims as AccessTokenClaims).exp !== 'number'
    ) {
      return null;
    }

    const typed = claims as AccessTokenClaims;
    if (!USER_KINDS.has(typed.typ)) return null;
    if (typed.exp * 1000 <= Date.now()) return null;

    return typed;
  } catch {
    return null;
  }
}

/**
 * How long an access token minted for this surface is good for.
 *
 * Two numbers rather than one, because the two surfaces are used differently.
 * The storefront and the Seller Hub get an hour: a seller works through their
 * application out of a folder of certificates, and a token that expired while
 * they were reading a registration number off a printout used to take the step
 * they were filling in with it. The admin console keeps the old quarter of an
 * hour, because the account that can refund an order and read a customer's
 * address is the one left unattended on a shared desk, and signing in again
 * there costs a member of staff seconds.
 *
 * The driver app follows the storefront. A trip already has its own, longer
 * token - see `LOGISTICS_TRIP_TOKEN_TTL_HOURS` - and this is only the session
 * behind it.
 */
export function accessTokenTtlFor(userType: UserKind): number {
  return userType === 'ADMIN' ? env.ADMIN_ACCESS_TOKEN_TTL_SECONDS : env.ACCESS_TOKEN_TTL_SECONDS;
}

// --- Session lifecycle -----------------------------------------------------

/**
 * The position an admin session was opened from, carried from one rotation to
 * the next. See `carriedLocation` on `createSessionRow`.
 */
interface SessionCarriedColumns {
  /**
   * When this family passed its second-factor challenge.
   *
   * Carried across a rotation for exactly the reason the position below is: a
   * browser in use refreshes every few minutes, and a replacement row that
   * started empty would put a dispatcher back on the authenticator screen
   * several times an hour. The factor belongs to the SIGN-IN, not to the
   * token.
   *
   * What still ends it is what should: signing out, a password change, a
   * reused refresh token, or the refresh token's own expiry - all four revoke
   * the family, and a new family starts with this null.
   */
  mfaVerifiedAt: Date | null;
  locationLatitude: Prisma.Decimal | null;
  locationLongitude: Prisma.Decimal | null;
  locationAccuracyM: number | null;
  locationLabel: string | null;
  /**
   * Carried like the rest of it, and it has to be.
   *
   * The country is read by the console itself - the market it prices for, and
   * the language it switches to - so a rotation that dropped it would put a
   * member of staff back on the seller's own market and back into English
   * several times a shift, without anything on screen explaining why.
   */
  locationCountry: string | null;
  locationCapturedAt: Date | null;
}

/** Create a fresh session family after a successful sign-in. */
export async function issueSession(
  userId: string,
  userType: UserKind,
  context: SessionContext = {},
): Promise<IssuedSession> {
  const sessionId = newId();
  const familyId = newId();
  // No location: this is a new sign-in, and asking for one afresh is the whole
  // point of the gate in `requireAdmin`.
  return createSessionRow(sessionId, familyId, userId, userType, context, null);
}

async function createSessionRow(
  sessionId: string,
  familyId: string,
  userId: string,
  userType: UserKind,
  context: SessionContext,
  /**
   * Copied from the session being replaced, and null for a brand-new one.
   *
   * A refresh happens every few minutes in a browser that is being used. If the
   * replacement row started empty, the console would fall back to the location
   * screen mid-task, several times an hour, for somebody who has not moved. The
   * position belongs to the sign-in, not to the token, so it travels with the
   * family.
   */
  carried: SessionCarriedColumns | null,
): Promise<IssuedSession> {
  const { token: refreshToken, tokenHash } = generateToken(32);

  const now = Date.now();
  const refreshTokenExpiresAt = new Date(now + env.REFRESH_TOKEN_TTL_SECONDS * 1000);
  const accessTokenExpiresAt = new Date(now + accessTokenTtlFor(userType) * 1000);

  await prisma.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: tokenHash,
      familyId,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipAddress: context.ipAddress ?? null,
      expiresAt: refreshTokenExpiresAt,
      ...(carried ?? {}),
    },
  });

  const accessToken = signAccessToken({
    sub: userId,
    sid: sessionId,
    typ: userType,
    iat: Math.floor(now / 1000),
    exp: Math.floor(accessTokenExpiresAt.getTime() / 1000),
  });

  return { sessionId, accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
}

/**
 * Exchange a refresh token for a new session in the same family.
 *
 * The reuse branch is the security-critical one: a token that exists but is
 * already revoked means the secret leaked, so the entire family is destroyed.
 */
export async function rotateSession(
  refreshToken: string,
  context: SessionContext = {},
): Promise<IssuedSession> {
  const tokenHash = sha256Hex(refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
    include: { user: { select: { id: true, type: true, status: true, archivedAt: true } } },
  });

  if (session === null) {
    throw unauthorized(ErrorCode.SESSION_EXPIRED, 'Your session is no longer valid.');
  }

  if (session.revokedAt !== null) {
    // Refresh-token reuse. Revoke the whole family and make both the attacker
    // and the legitimate client sign in again.
    await revokeFamily(session.familyId, 'refresh_token_reuse_detected');

    await recordAudit({
      action: AuditAction.USER_REFRESH_REUSE_DETECTED,
      resourceType: 'session',
      resourceId: session.id,
      actorType: session.user.type === 'ADMIN' ? 'ADMIN' : 'CUSTOMER',
      actorUserId: session.userId,
      after: { familyId: session.familyId, revokedSessions: 'all' },
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      correlationId: context.correlationId ?? null,
    });

    throw unauthorized(
      ErrorCode.REFRESH_TOKEN_REUSED,
      'This session was ended for security reasons. Please sign in again.',
    );
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized(ErrorCode.SESSION_EXPIRED, 'Your session has expired. Please sign in again.');
  }

  // The account may have been deactivated after the session was issued.
  if (session.user.archivedAt !== null || session.user.status !== 'ACTIVE') {
    await revokeFamily(session.familyId, 'account_not_active');
    throw unauthorized(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is no longer active.');
  }

  const nextSessionId = newId();

  const issued = await createSessionRow(
    nextSessionId,
    session.familyId,
    session.userId,
    session.user.type,
    context,
    {
      mfaVerifiedAt: session.mfaVerifiedAt,
      locationLatitude: session.locationLatitude,
      locationLongitude: session.locationLongitude,
      locationAccuracyM: session.locationAccuracyM,
      locationLabel: session.locationLabel,
      locationCountry: session.locationCountry,
      locationCapturedAt: session.locationCapturedAt,
    },
  );

  // Revoke the consumed token only after the replacement exists, so a crash in
  // between leaves the client with a still-working token rather than none.
  await prisma.session.update({
    where: { id: session.id },
    data: {
      revokedAt: new Date(),
      revokedReason: 'rotated',
      replacedBySessionId: nextSessionId,
    },
  });

  return issued;
}

/** What a guard needs to know about the session behind an access token. */
export interface SessionAuthState {
  /** Present, unrevoked and unexpired. */
  isActive: boolean;
  /** The browser has told us where this sign-in happened. */
  hasLocation: boolean;
  /**
   * When THIS session passed its second-factor challenge, or null.
   *
   * Read by the logistics guard. Per session rather than per account: the
   * account column says a second factor EXISTS, this says the browser in front
   * of us has presented it, and without the distinction enrolling once would
   * leave every later sign-in single-factor.
   */
  mfaVerifiedAt: Date | null;
  /**
   * The country it happened in, when a geocoder named one.
   *
   * The console prices its catalogue for this: a member of staff is shown what
   * a customer where they are sitting pays. Null leaves the panel quoting the
   * seller's own country.
   */
  country: string | null;
  /**
   * The place that sign-in came from, as a person reads it.
   *
   * The geocoded name where one was resolved, the coordinates where it was
   * not, and null where the browser has said nothing at all. The panel puts it
   * in the top bar: somebody who has two consoles open, or who was handed a
   * laptop, can see which sign-in they are looking at.
   */
  place: string | null;
  /**
   * When THIS session opened the Seller Hub's lock, and for which seller.
   *
   * The same distinction `mfaVerifiedAt` draws, one layer along: the member row
   * says the seller password EXISTS, this says the browser in front of us has
   * entered it. The id is carried because a person can sell for two businesses,
   * and opening one must not open the other.
   */
  sellerUnlockedAt: Date | null;
  sellerUnlockedForId: string | null;
}

/**
 * The session row, as the guards see it.
 *
 * Every fact comes from one query on purpose: `requireAdmin` needs each of
 * them on every single request, and two round trips per request to the same row
 * is a cost a self-hosted box pays for nothing.
 */
export async function getSessionAuthState(sessionId: string): Promise<SessionAuthState> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      revokedAt: true,
      expiresAt: true,
      locationCapturedAt: true,
      locationCountry: true,
      mfaVerifiedAt: true,
      sellerUnlockedAt: true,
      sellerUnlockedForId: true,
      // For the top bar. The coordinates are the fallback label, which is why
      // they are read here and not only the name.
      locationLabel: true,
      locationLatitude: true,
      locationLongitude: true,
    },
  });

  if (session === null || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
    return {
      isActive: false,
      hasLocation: false,
      mfaVerifiedAt: null,
      country: null,
      place: null,
      sellerUnlockedAt: null,
      sellerUnlockedForId: null,
    };
  }

  return {
    isActive: true,
    hasLocation: session.locationCapturedAt !== null,
    mfaVerifiedAt: session.mfaVerifiedAt,
    country: session.locationCountry,
    place: sessionPlace(session),
    sellerUnlockedAt: session.sellerUnlockedAt,
    sellerUnlockedForId: session.sellerUnlockedForId,
  };
}

/**
 * The label for one session's position.
 *
 * The geocoder's name when there is one, the coordinates when there is not,
 * and null when nothing was ever recorded. Same order as the notification
 * line, so the bell and the top bar cannot disagree about where a session
 * came from.
 */
function sessionPlace(session: {
  locationLabel: string | null;
  locationLatitude: Prisma.Decimal | null;
  locationLongitude: Prisma.Decimal | null;
}): string | null {
  if (session.locationLabel !== null) return session.locationLabel;

  if (session.locationLatitude === null || session.locationLongitude === null) return null;

  return formatCoordinates(Number(session.locationLatitude), Number(session.locationLongitude));
}

/** True when the session is present, unrevoked and unexpired. */
export async function isSessionActive(sessionId: string): Promise<boolean> {
  return (await getSessionAuthState(sessionId)).isActive;
}

export async function revokeSession(sessionId: string, reason = 'logout'): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeFamily(familyId: string, reason: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/**
 * Revoke every session for a user. Used on password change, deactivation and
 * role change - the SOP requires that a deactivated user immediately loses
 * access, not merely fails their next sign-in.
 */
export async function revokeAllUserSessions(userId: string, reason: string): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/** Housekeeping: drop sessions that expired long ago. */
export async function purgeExpiredSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { lastUsedAt: new Date() },
  });
}
