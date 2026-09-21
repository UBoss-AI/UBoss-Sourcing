/**
 * A generic JSON rate feed.
 *
 * This is the shape almost every free rates API answers in:
 *
 *   { "base": "EUR", "date": "2026-09-18", "rates": { "USD": 1.0812, ... } }
 *
 * It exists for two reasons, and the second is the one that matters:
 *
 *   - A deployment may already pay for a feed, or mirror one inside its own
 *     network. `{base}` in the URL is substituted, so pointing at a mirror is a
 *     configuration change.
 *   - It is what this system used before there was a provider interface at all.
 *     Keeping it, with the same default URL, means an existing deployment that
 *     upgrades does not silently change where its rates come from. Changing a
 *     shop's price source as a side effect of an upgrade would be exactly the
 *     kind of quiet financial change the project rules forbid.
 *
 * WHAT IT DOES NOT TRUST
 *
 * JSON numbers. `{"rates":{"INR":0.011}}` has already lost precision before
 * this code runs, but worse, re-serialising it through `Number.prototype
 * .toFixed` is the only honest thing left to do with it - so that is what
 * happens, at twelve places, and the result is a string from there on. A feed
 * that sends rates as strings is preferred and is passed through untouched.
 */
import { RATE_SCALE_DP } from '../../../domain/fx.js';
import {
  fetchWithTimeout,
  sanitiseRates,
  RateProviderError,
  type ProviderRateSet,
  type RateProvider,
} from './provider.js';

/**
 * A JSON number to a decimal string, at the scale everything downstream uses.
 *
 * The one place in the FX path where a float is touched, and it is unavoidable:
 * `JSON.parse` produced it before any of this code could object. `toFixed` is
 * the correct exit - it renders the double's decimal expansion, which is the
 * most faithful record of what the feed actually delivered.
 */
function numberToRateString(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(RATE_SCALE_DP);
}

export function parseJsonFeed(
  body: string,
  fallbackPivot: string,
  sourceReference: string,
): ProviderRateSet {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RateProviderError('The rate feed did not return JSON.', false);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new RateProviderError('The rate feed returned no object.', false);
  }

  const envelope = parsed as Record<string, unknown>;
  const rawRates = envelope['rates'];

  if (typeof rawRates !== 'object' || rawRates === null) {
    throw new RateProviderError('The rate feed returned no rates.', true);
  }

  const pivot =
    typeof envelope['base'] === 'string' && /^[A-Za-z]{3}$/.test(envelope['base'])
      ? envelope['base'].toUpperCase()
      : fallbackPivot.toUpperCase();

  const raw: [string, unknown][] = Object.entries(rawRates as Record<string, unknown>).map(
    ([code, value]) => [
      code,
      typeof value === 'number' ? numberToRateString(value) : value,
    ],
  );

  const { rates, rejectedCount } = sanitiseRates(raw, pivot);

  if (rates.size === 0) {
    throw new RateProviderError('The rate feed returned no usable rates.', true);
  }

  // A feed that dates its own list is taken at its word; one that does not is
  // dated now, because that is the only honest reading of "these are current".
  const dated = envelope['date'] ?? envelope['time_last_update_utc'];
  const asOf =
    typeof dated === 'string' && !Number.isNaN(new Date(dated).getTime())
      ? new Date(dated)
      : new Date();

  return {
    provider: 'json',
    pivotCurrency: pivot,
    asOf,
    rates,
    sourceReference,
    rejectedCount,
  };
}

export function createJsonProvider(urlTemplate: string, pivotCurrency: string): RateProvider {
  const url = urlTemplate.replace('{base}', encodeURIComponent(pivotCurrency));

  return {
    name: 'json',
    pivotCurrency: pivotCurrency.toUpperCase(),
    publishesOnWorkingDaysOnly: false,
    description:
      'A JSON exchange-rate feed configured for this deployment. Its accuracy, update frequency and ' +
      'terms are whatever the chosen feed offers; nothing here can make it a settlement rate.',

    async fetch(options): Promise<ProviderRateSet> {
      const body = await fetchWithTimeout(url, {
        timeoutMs: options.timeoutMs,
        accept: 'application/json',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      return parseJsonFeed(body, pivotCurrency, url);
    },
  };
}
