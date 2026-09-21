/**
 * Where rates come from.
 *
 * An interface with two implementations today, and the reason it is an
 * interface is not tidiness. A reference rate and a settlement rate are
 * different products: the European Central Bank publishes an *indicative*
 * mid-market figure once a working day for information, and a payment provider
 * quotes the rate it will actually settle at, with its own spread, valid for
 * seconds. A deployment that grows from the first to the second should change
 * one configuration value, not the pricing logic.
 *
 * WHAT A PROVIDER IS RESPONSIBLE FOR
 *
 *   - Fetching, with its own timeout.
 *   - Parsing its own wire format. Nothing outside this folder knows what shape
 *     the ECB's XML is or that `open.er-api.com` nests its rates under `rates`.
 *   - Saying what it quotes against - its pivot - and for what date.
 *   - Dropping rows it cannot vouch for, and saying how many it dropped.
 *
 * WHAT A PROVIDER IS NOT RESPONSIBLE FOR
 *
 *   - Deciding whether a result is good enough to activate. That is
 *     `fx-snapshot.service.ts`, which compares against what is already stored;
 *     a provider has nothing to compare against and would be guessing.
 *   - Cross-rates, margins, rounding or currency exponents. All of that lives
 *     in `domain/fx.ts` and `bulk-price.service.ts` on purpose, so a second
 *     provider cannot arrive with a second opinion about arithmetic.
 */
import { isUsableRate } from '../../../domain/fx.js';

/** What a provider hands back. Rates are decimal strings, never numbers. */
export interface ProviderRateSet {
  /** Stable identifier stored on every snapshot row, e.g. "ecb". */
  provider: string;
  /** The currency everything is quoted against. */
  pivotCurrency: string;
  /** The date the PROVIDER says these rates are for, not when we fetched. */
  asOf: Date;
  /** Quote currency -> decimal string. Excludes the pivot itself. */
  rates: Map<string, string>;
  /**
   * Where this came from, for the audit trail: a URL, a feed name, a document
   * date. Never a credential, and never a full response body.
   */
  sourceReference: string;
  /** Rows the provider saw and refused. Reported, not hidden. */
  rejectedCount: number;
}

export interface RateProvider {
  readonly name: string;
  /** The currency this provider quotes against, before any cross-rate. */
  readonly pivotCurrency: string;
  /**
   * True when the provider publishes on a schedule rather than continuously,
   * so a set that has not moved since yesterday is expected rather than a
   * fault. Drives what the health check calls "stale".
   */
  readonly publishesOnWorkingDaysOnly: boolean;
  /**
   * One sentence a human reads on the settings screen, including the honest
   * caveat. Shown verbatim, so it says what the rates are and are not.
   */
  readonly description: string;

  fetch(options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProviderRateSet>;
}

export class RateProviderError extends Error {
  /** True when retrying the same call could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RateProviderError';
    this.retryable = retryable;
  }
}

/**
 * Keep only rows that are a currency code and a usable rate.
 *
 * Shared by every provider so one cannot be laxer than another. A code that is
 * not three letters, or a rate that is not a plain positive decimal, is dropped
 * with a count rather than thrown on: one nonsense row in a list of thirty
 * should not cost a deployment its whole refresh, and the count is what makes
 * the drop visible instead of silent.
 */
export function sanitiseRates(
  raw: Iterable<readonly [string, unknown]>,
  pivotCurrency: string,
): { rates: Map<string, string>; rejectedCount: number } {
  const rates = new Map<string, string>();
  let rejectedCount = 0;

  for (const [rawCode, rawValue] of raw) {
    const code = rawCode.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(code)) {
      rejectedCount += 1;
      continue;
    }

    // The pivot quoted against itself is either 1 or noise. Either way it is
    // not information: `crossRate` knows the pivot is 1 without being told.
    if (code === pivotCurrency.toUpperCase()) continue;

    const text = typeof rawValue === 'string' ? rawValue.trim() : null;

    if (text === null || !isUsableRate(text)) {
      rejectedCount += 1;
      continue;
    }

    rates.set(code, text);
  }

  return { rates, rejectedCount };
}

/**
 * Fetch with a hard timeout that does not depend on the caller remembering one.
 *
 * `AbortSignal.timeout` bounds the whole exchange including the body read,
 * which `fetch`'s own behaviour does not: a server that sends headers promptly
 * and then dribbles a body forever would otherwise hold the worker open until
 * the process restarted.
 */
export async function fetchWithTimeout(
  url: string,
  options: { timeoutMs: number; accept: string; signal?: AbortSignal },
): Promise<string> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);

  let response: Response;

  try {
    response = await fetch(url, { headers: { accept: options.accept }, signal });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'the request failed';
    throw new RateProviderError(`The rate feed could not be reached: ${reason}`, true);
  }

  if (!response.ok) {
    // 4xx is a configuration fault - a wrong URL, a revoked key - and retrying
    // it just burns the schedule. 5xx and 429 are worth coming back for.
    const retryable = response.status >= 500 || response.status === 429;
    throw new RateProviderError(`The rate feed answered ${String(response.status)}.`, retryable);
  }

  try {
    return await response.text();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'the body could not be read';
    throw new RateProviderError(`The rate feed response was unreadable: ${reason}`, true);
  }
}
