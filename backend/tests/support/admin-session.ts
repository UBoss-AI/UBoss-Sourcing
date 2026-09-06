/**
 * Signing in as staff, the way a browser does it.
 *
 * Two requests, not one. Since the sign-in location gate, an admin session that
 * has only presented a password can reach `/me`, `/logout` and nothing else -
 * every other admin route answers 403 LOCATION_REQUIRED until the panel posts
 * the browser's position. A test that stopped after the login would be
 * exercising a state no real console is ever in for longer than a second.
 *
 * Reach for this in any test that signs in over HTTP and then calls an admin
 * route. A test that deliberately wants the half-finished session - proving the
 * gate itself - should call the login route directly and skip this.
 */
import { expect } from 'vitest';
import type { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';

export interface AdminSession {
  /** Ready for the `cookie` header. */
  cookies: string;
  /** Copy into `x-csrf-token` on every write. */
  csrfToken: string;
}

export interface SignInOptions {
  email: string;
  password: string;
  /**
   * A per-file source address. The login route is rate limited by IP, so files
   * that share one spend each other's budget and fail in whichever order the
   * suite happens to run.
   */
  ip?: string;
  /** Somewhere in Pune, near enough. Any valid pair does. */
  latitude?: number;
  longitude?: number;
  /**
   * The country the session should look as though it signed in from.
   *
   * The console prices its catalogue for this, and there is no query parameter
   * to override it - see `setSessionCountry` for why a test has to state it
   * rather than let a geocoder decide.
   */
  country?: string;
}

export async function signInAdmin(
  app: Awaited<ReturnType<typeof buildApp>>,
  options: SignInOptions,
): Promise<AdminSession> {
  const headers = options.ip === undefined ? {} : { 'x-forwarded-for': options.ip };

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    headers,
    payload: { email: options.email, password: options.password },
  });

  expect(login.statusCode, login.body).toBe(200);

  const jar = login.cookies as { name: string; value: string }[];
  const cookies = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const csrfToken = jar.find((cookie) => cookie.name === 'uboss_admin_csrf')?.value ?? '';

  const located = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/session/location',
    headers: { ...headers, cookie: cookies, 'x-csrf-token': csrfToken },
    payload: {
      latitude: options.latitude ?? 18.5204,
      longitude: options.longitude ?? 73.8567,
      accuracyM: 42,
    },
  });

  expect(located.statusCode, located.body).toBe(200);

  if (options.country !== undefined) await setSessionCountry(options.email, options.country);

  return { cookies, csrfToken };
}

/**
 * Say which country this account's live sessions signed in from.
 *
 * In production the reverse geocoder writes this column while the position is
 * being recorded. The suite has no geocoder - `tests/setup.ts` empties
 * `GEOCODE_REVERSE_URL`, because a test that reaches OpenStreetMap is a test
 * that fails when a firewall says so - so a test that needs a market states it
 * here instead, writing exactly the column a real sign-in would have written.
 *
 * Every unrevoked session of the account, rather than the one just opened: the
 * helper has cookies, not a session id, and an account under test has one live
 * session anyway.
 */
export async function setSessionCountry(email: string, country: string | null): Promise<void> {
  await prisma.session.updateMany({
    where: { user: { emailNormalized: email.trim().toLowerCase() }, revokedAt: null },
    data: { locationCountry: country },
  });
}
