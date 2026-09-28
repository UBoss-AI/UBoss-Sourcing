/**
 * One way to call a registry, so every provider fails the same way.
 *
 * The URLs are deployment configuration (BUYER_COMPANY_*_URL), not anything a
 * buyer sends, and the only values interpolated into them are identifiers
 * that have already passed their own shape check - digits and capital
 * letters. That is why this uses plain `fetch` like the VIES client next door
 * rather than `safeFetch`, which exists for addresses somebody typed.
 */
import { env } from '../../../config/env.js';
import { logger } from '../../../infra/logger.js';

export type RegistryResponse =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'not-found'; status: number }
  | { kind: 'rejected'; status: number; body: unknown }
  | { kind: 'unavailable'; reason: string };

/** GET a JSON document, classifying every failure instead of throwing. */
export async function getRegistryJson(url: string, source: string): Promise<RegistryResponse> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // Registries throttle anonymous clients first.
        'user-agent': `UBOSS/1.0 (+${env.API_PUBLIC_URL})`,
      },
      signal: AbortSignal.timeout(env.BUYER_COMPANY_REGISTRY_TIMEOUT_MS),
    });

    if (response.status === 404) return { kind: 'not-found', status: 404 };

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // An HTML error page from a proxy is not an answer about the company.
      return {
        kind: 'unavailable',
        reason: `${source} answered ${String(response.status)} with no readable body.`,
      };
    }

    if (response.status >= 500 || response.status === 429) {
      return { kind: 'unavailable', reason: `${source} answered ${String(response.status)}.` };
    }
    if (response.status >= 400) return { kind: 'rejected', status: response.status, body };

    return { kind: 'ok', status: response.status, body };
  } catch (error) {
    // Deliberately no identifier in the log line - only which source failed.
    logger.warn({ err: error, source }, 'business registry lookup failed');
    return { kind: 'unavailable', reason: `${source} could not be reached.` };
  }
}

/** A string field of an unknown object, trimmed, or null. */
export function field(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current !== 'string') return null;
  const trimmed = current.trim();
  return trimmed.length === 0 ? null : trimmed;
}
