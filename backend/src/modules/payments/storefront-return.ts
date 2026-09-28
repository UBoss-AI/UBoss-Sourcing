/**
 * Where a payment gateway sends the customer back to.
 *
 * The customer must come back to the SAME address they paid from. Their
 * session cookie belongs to that address, so returning them to another one -
 * the configured public URL when they reached the shop through a second
 * hostname, a tunnel, or `localhost` - lands them on a storefront where they
 * look signed out, in the middle of paying. That is what happened while the
 * return address was always `CUSTOMER_WEB_PUBLIC_URL`.
 *
 * The address is still never the browser's choice. The request's `Origin` is
 * used only when it is EXACTLY one of the storefront origins this deployment
 * already trusts for CORS (`CUSTOMER_WEB_ORIGIN`); anything else - absent,
 * unknown, a lookalike - falls back to `CUSTOMER_WEB_PUBLIC_URL`. So a caller
 * can pick between addresses the operator configured and nothing more, which
 * is not an open redirect: there is no value it can send that makes a gateway
 * hand a customer to a page the operator does not run.
 */
import { env } from '../../config/env.js';

export function storefrontReturnBase(requestOrigin: string | null | undefined): string {
  const configured = env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/+$/, '');
  if (requestOrigin === null || requestOrigin === undefined) return configured;

  const origin = requestOrigin.trim().replace(/\/+$/, '');
  return env.CUSTOMER_WEB_ORIGIN.includes(origin) ? origin : configured;
}
