/**
 * Signing secrets, current and previous.
 *
 * A signing secret is rotated without signing anybody out by running with two
 * values for a while: the new one signs, and both verify. Once everything the
 * old one signed has expired, the old value is removed.
 *
 *   SESSION_COOKIE_SECRET / _PREVIOUS   cookie signatures, and the keys derived
 *                                       from it (document verification codes,
 *                                       delivery and e-mail codes, quotes)
 *   ACCESS_TOKEN_SECRET / _PREVIOUS     the 15-minute access token
 *
 * Only VERIFICATION reads the previous value. Anything newly signed is signed
 * with the current one, so a previous value stops being needed on its own.
 */
import { env } from '../config/env.js';

function withPrevious(current: string, previous: string): readonly string[] {
  const older = previous
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value !== current);
  return [current, ...older];
}

/** The session secret first, then any previous values still accepted. */
export function sessionSecrets(): readonly string[] {
  return withPrevious(env.SESSION_COOKIE_SECRET, env.SESSION_COOKIE_SECRET_PREVIOUS);
}

/** The access-token secret first, then any previous values still accepted. */
export function accessTokenSecrets(): readonly string[] {
  return withPrevious(env.ACCESS_TOKEN_SECRET, env.ACCESS_TOKEN_SECRET_PREVIOUS);
}
