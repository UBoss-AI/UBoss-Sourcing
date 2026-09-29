/**
 * A bot check on the storefront's public forms: sign-in, sign-up and
 * "forgot my password".
 *
 * PROVIDER-AGNOSTIC, AND OFF BY DEFAULT
 *
 * `CAPTCHA_PROVIDER` picks the driver - `turnstile` (Cloudflare) or `hcaptcha`
 * - and `off` is the default, which is right for a laptop and for a
 * deployment that relies on the rate limits in front of these routes. Keys are
 * settings (`CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET_KEY`), never code: this
 * software is run by whoever bought it, with their own provider account.
 *
 * Both providers speak the same protocol: the widget in the page produces a
 * token, and the server posts `secret`, `response` and `remoteip` to the
 * provider's `siteverify` and reads `success`. So one function serves both and
 * a third provider with the same protocol is one line in `VERIFY_URLS`.
 *
 * IT FAILS CLOSED
 *
 * A token the provider refuses, a provider that cannot be reached in
 * CAPTCHA_TIMEOUT_MS, an answer that is not JSON - each refuses the form with
 * CAPTCHA_FAILED. A bot check that waves traffic through whenever the provider
 * is slow is a bot check an attacker can switch off by being slow.
 *
 * The secret key is sent only to the provider and never logged.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';

const VERIFY_URLS = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
} as const;

export type CaptchaAction = 'login' | 'register' | 'password_forgot';

/** What the storefront needs to draw the widget. The site key is public. */
export function publicCaptchaConfig(): { provider: 'off' | 'turnstile' | 'hcaptcha'; siteKey: string | null } {
  return env.CAPTCHA_PROVIDER === 'off'
    ? { provider: 'off', siteKey: null }
    : { provider: env.CAPTCHA_PROVIDER, siteKey: env.CAPTCHA_SITE_KEY };
}

/**
 * Refuse unless the bot check passed. A no-op while CAPTCHA_PROVIDER is off.
 *
 * The token arrives as `captchaToken` in the JSON body, or the
 * `x-captcha-token` header for a client that prefers not to touch the body.
 */
export async function assertCaptcha(params: {
  token: string | null | undefined;
  action: CaptchaAction;
  remoteIp: string | null;
}): Promise<void> {
  if (env.CAPTCHA_PROVIDER === 'off') return;

  const token = (params.token ?? '').trim();
  if (token.length === 0 || token.length > 4096) {
    throw badRequest(ErrorCode.CAPTCHA_REQUIRED, 'Complete the check that you are not a robot.', [
      { field: 'captchaToken', code: 'REQUIRED' },
    ]);
  }

  const url =
    env.CAPTCHA_VERIFY_URL.length > 0 ? env.CAPTCHA_VERIFY_URL : VERIFY_URLS[env.CAPTCHA_PROVIDER];
  const form = new URLSearchParams({ secret: env.CAPTCHA_SECRET_KEY, response: token });
  if (params.remoteIp !== null && params.remoteIp.length > 0) form.set('remoteip', params.remoteIp);

  let success: boolean;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(env.CAPTCHA_TIMEOUT_MS),
    });
    const body = (await response.json()) as { success?: unknown };
    success = response.ok && body.success === true;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : 'unknown', action: params.action },
      'bot check could not be verified',
    );
    success = false;
  }

  if (!success) {
    throw badRequest(ErrorCode.CAPTCHA_FAILED, 'The check that you are not a robot did not pass. Try it again.', [
      { field: 'captchaToken', code: 'REJECTED' },
    ]);
  }
}

/** Read the token from a request body or header, without trusting its shape. */
export function captchaTokenFrom(body: unknown, header: string | string[] | undefined): string | null {
  if (typeof body === 'object' && body !== null) {
    const value = (body as { captchaToken?: unknown }).captchaToken;
    if (typeof value === 'string') return value;
  }
  return typeof header === 'string' ? header : null;
}
