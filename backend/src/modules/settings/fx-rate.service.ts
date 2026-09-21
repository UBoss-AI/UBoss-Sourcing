/**
 * Keeping converted prices current, without converting at read time.
 *
 * The rule this module works around, not against: the catalogue stores a real
 * figure per currency, and the storefront quotes it verbatim. A rate applied
 * when the page renders would let the amount charged differ from the amount
 * shown - the cart, the tax on it, the coupon minimum it has to clear and the
 * payment all read that number, and they are computed at different moments.
 *
 * So the rate is used at *write* time. A daily job fetches rates, re-converts
 * the prices that were themselves produced by conversion, and stores the
 * results. Between runs the catalogue is as fixed as a hand-typed one, and at
 * the moment of purchase the shopper is charged exactly what the page said.
 *
 * Three things keep an unattended job honest:
 *
 *   - **It only touches what it wrote.** `isAutoConverted` is cleared the
 *     moment a person edits a price, and the refresh skips anything without it.
 *   - **It refuses a suspicious move.** A feed returning a wrong base or a
 *     shifted decimal is a catalogue-wide mispricing at 3am. Past
 *     `maxDriftPercent`, the run writes nothing at all rather than half of it.
 *   - **It only refreshes markets that already exist.** A currency nobody has
 *     priced anything in stays empty; opening a market is a decision, and this
 *     is not the thing that should make it.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { QUOTE_DP, applyAdjustment, formatRate, parseRate, resolveRate } from '../../domain/fx.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  bulkPriceFromCurrency,
  type BulkPriceResult,
  type PriceRounding,
} from '../catalog/bulk-price.service.js';
import { getBaseCurrency } from './currency.service.js';
import {
  FX_SETTINGS_ID,
  activeRateSet,
  freshnessPolicyFrom,
  availableProviders,
  refreshRateSnapshot,
  type ProviderChoice,
} from './fx-snapshot.service.js';

/**
 * One settings row, addressed by a fixed id.
 *
 * A singleton table rather than a key-value store: every field here is typed,
 * and a percentage that arrives as the string "abc" should fail at the column
 * rather than three layers later in bigint arithmetic.
 *
 * Aliased from the snapshot service rather than declared twice. Two copies of
 * a magic id is two things to keep in step, and the failure when they drift is
 * a second settings row that nothing reads.
 */
const SETTINGS_ID = FX_SETTINGS_ID;

export interface FxRateSettings {
  isEnabled: boolean;
  /** Percent added on top of the mid-market conversion. */
  marginPercent: string;
  rounding: PriceRounding;
  maxDriftPercent: string;
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'skipped' | 'failed' | null;
  lastRunMessage: string | null;
  lastRunUpdated: number;

  /** Which feed, and what each of the available ones actually is. */
  provider: string;
  providerChoices: ProviderChoice[];

  /** Read-time conversion for markets with no price rows of their own. */
  deriveMissingPrices: boolean;

  /** The three freshness windows, in hours. See the schema for the arithmetic. */
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  alertMaxAgeHours: number;
  quoteTtlSeconds: number;
}

export interface FxRateSettingsInput {
  isEnabled?: boolean;
  marginPercent?: string;
  rounding?: PriceRounding;
  maxDriftPercent?: string;
  provider?: string;
  deriveMissingPrices?: boolean;
  displayMaxAgeHours?: number;
  checkoutMaxAgeHours?: number;
  alertMaxAgeHours?: number;
  quoteTtlSeconds?: number;
}

interface SettingsRow {
  isEnabled: boolean;
  marginPercent: Prisma.Decimal;
  rounding: string;
  maxDriftPercent: Prisma.Decimal;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunUpdated: number;
  provider: string;
  deriveMissingPrices: boolean;
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  alertMaxAgeHours: number;
  quoteTtlSeconds: number;
}

function isRounding(value: string): value is PriceRounding {
  return value === 'exact' || value === 'whole' || value === 'charm';
}

function view(row: SettingsRow): FxRateSettings {
  return {
    isEnabled: row.isEnabled,
    marginPercent: row.marginPercent.toFixed(2),
    // A value outside the set can only come from a hand-edited database. Fall
    // back rather than throw: a bad rounding rule must not make the settings
    // screen unreachable, which is where somebody would fix it.
    rounding: isRounding(row.rounding) ? row.rounding : 'charm',
    maxDriftPercent: row.maxDriftPercent.toFixed(2),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus:
      row.lastRunStatus === 'ok' || row.lastRunStatus === 'skipped' || row.lastRunStatus === 'failed'
        ? row.lastRunStatus
        : null,
    lastRunMessage: row.lastRunMessage,
    lastRunUpdated: row.lastRunUpdated,

    provider: row.provider,
    // The list is sent with the settings rather than from a second endpoint so
    // the screen can show what each feed actually is - including the ECB's own
    // caveat that its rates are for information and are not transaction rates.
    // An administrator choosing a rate source should read that sentence at the
    // moment they choose, not find it in a document afterwards.
    providerChoices: availableProviders(),

    deriveMissingPrices: row.deriveMissingPrices,
    displayMaxAgeHours: row.displayMaxAgeHours,
    checkoutMaxAgeHours: row.checkoutMaxAgeHours,
    alertMaxAgeHours: row.alertMaxAgeHours,
    quoteTtlSeconds: row.quoteTtlSeconds,
  };
}

/**
 * Refuse a set of windows that cannot all hold at once.
 *
 * The three have to stay in order - alert before checkout before display - or
 * they stop meaning what they are named. A checkout window longer than the
 * display window would let money be taken against a rate too old to show a
 * price from, and an alert that fires after checkout has already started
 * failing is a report rather than a warning.
 */
function assertWindowsOrdered(next: {
  alertMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  displayMaxAgeHours: number;
}): void {
  if (next.alertMaxAgeHours > next.checkoutMaxAgeHours) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The alert threshold must be at or below the checkout limit, or nobody is warned before sales start failing.',
      [{ field: 'alertMaxAgeHours', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  if (next.checkoutMaxAgeHours > next.displayMaxAgeHours) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The checkout limit must be at or below the display limit, or money could be taken against a rate too old to show a price from.',
      [{ field: 'checkoutMaxAgeHours', code: ErrorCode.VALIDATION_FAILED }],
    );
  }
}

/** The settings, creating the row on first read so nothing else has to. */
export async function getFxRateSettings(): Promise<FxRateSettings> {
  const row = await prisma.currencyRateSync.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });

  return view(row);
}

export async function updateFxRateSettings(
  input: FxRateSettingsInput,
  actorId: string | null,
): Promise<FxRateSettings> {
  const current = await getFxRateSettings();

  if (input.provider !== undefined) {
    // A closed list, checked here rather than trusted from the request. The
    // provider decides where this server makes an outbound request to, and a
    // free-text field would be a server-side request forgery with an audit
    // entry attached.
    const known = availableProviders().some((choice) => choice.key === input.provider);

    if (!known) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown exchange rate provider.', [
        { field: 'provider', code: ErrorCode.VALIDATION_FAILED },
      ]);
    }
  }

  assertWindowsOrdered({
    alertMaxAgeHours: input.alertMaxAgeHours ?? current.alertMaxAgeHours,
    checkoutMaxAgeHours: input.checkoutMaxAgeHours ?? current.checkoutMaxAgeHours,
    displayMaxAgeHours: input.displayMaxAgeHours ?? current.displayMaxAgeHours,
  });

  const row = await prisma.currencyRateSync.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...input, updatedById: actorId },
    update: { ...input, updatedById: actorId },
  });

  return view(row);
}

// ---------------------------------------------------------------------------
// The rate feed
// ---------------------------------------------------------------------------

/**
 * Today's rates, expressed against the business's own base currency.
 *
 * WHAT CHANGED HERE, AND WHY IT HAD TO
 *
 * This function used to make its own HTTP request to `FX_RATE_URL` with the
 * base currency substituted into the path, and throw the response away after
 * using it. Two things were wrong with that:
 *
 *   - **It assumed every feed can be asked for an arbitrary base.** The
 *     European Central Bank cannot. It publishes against the euro and nothing
 *     else, so `?base=INR` is not a request it has an answer to. A deployment
 *     based in rupees could therefore never use the ECB at all.
 *   - **Nothing was kept.** When somebody asked six weeks later why a market
 *     was repriced overnight, there was no record of what the feed had said.
 *
 * So the fetch now lives in `fx-snapshot.service.ts`, which stores what it
 * receives, validates it before it is used and keeps the history. This reads
 * the stored set and crosses it into the base currency through the provider's
 * pivot - which is the one piece of arithmetic the ECB's shape forces on
 * everybody, and it lives in `domain/fx.ts` where it can be tested without a
 * network.
 *
 * Returns null when there is no usable set. The caller treats that as "change
 * nothing", which is the same thing the old unreachable-feed path did.
 */
export async function fetchRates(base: string): Promise<Map<string, string> | null> {
  const set = await activeRateSet();
  if (set === null) return null;

  const settings = await prisma.currencyRateSync.findUnique({
    where: { id: FX_SETTINGS_ID },
    select: { displayMaxAgeHours: true, checkoutMaxAgeHours: true },
  });

  if (settings === null) return null;

  const policy = freshnessPolicyFrom(settings);
  const rates = new Map<string, string>();

  // The pivot itself plus everything quoted against it. A currency the feed
  // does not quote is simply absent, and the caller reports it per currency
  // rather than failing the whole run - the dirham missing from an ECB list
  // must not cost the zloty its refresh.
  for (const code of [set.pivotCurrency, ...set.rates.keys()]) {
    try {
      const resolved = resolveRate(base, code, set, { purpose: 'display', policy });
      rates.set(code.toUpperCase(), resolved.midRate);
    } catch {
      // A pair that cannot be crossed - typically because the base currency
      // itself is not quoted - leaves that currency out.
    }
  }

  return rates.size === 0 ? null : rates;
}

/**
 * `rate * (1 + margin/100)`, kept exact and clamped to 8 decimal places.
 *
 * Now a thin wrapper over `domain/fx.ts`. The implementation this replaced did
 * its own arithmetic and did it with a float:
 *
 *     const margin = BigInt(Math.round(Number(marginPercent) * 100));
 *
 * `Number('1.15') * 100` is `114.99999999999999`, and `Math.round` rescued
 * that one by a hair. It is the only reason the function was ever right, and
 * it is not a reason that survives a margin somebody types next year. The
 * replacement parses the percentage as a fraction and never leaves bigint.
 *
 * Eight decimal places out, because that is what `conversionFor` accepts and
 * what every caller and test here already depends on.
 */
export function applyMargin(rate: string, marginPercent: string): string {
  return formatRate(parseRate(applyAdjustment(rate, marginPercent)), QUOTE_DP);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface FxRefreshCurrency {
  currency: string;
  rate: string;
  updated: number;
  skipped: number;
  maxDriftPercent: string | null;
  /** Why this currency was left alone, or null when it was refreshed. */
  error: string | null;
}

export interface FxRefreshResult {
  status: 'ok' | 'skipped' | 'failed';
  message: string;
  baseCurrency: string;
  currencies: FxRefreshCurrency[];
  updated: number;
}

/**
 * Which markets the refresh is responsible for.
 *
 * Exactly those that already hold at least one rate-maintained price. A
 * currency priced entirely by hand is somebody's deliberate work and is left
 * alone; a currency with nothing in it is a market that has not been opened.
 */
async function managedCurrencies(baseCurrency: string): Promise<string[]> {
  const rows = await prisma.productPrice.groupBy({
    by: ['currencyCode'],
    where: { isAutoConverted: true, currencyCode: { not: baseCurrency } },
  });

  return rows.map((row) => row.currencyCode).sort();
}

/**
 * Refresh every rate-maintained price.
 *
 * `trigger` only changes what gets logged and reported - a scheduled run and a
 * "Refresh now" from the settings screen do exactly the same work, so the
 * button is a real test of what the schedule will do rather than a different
 * path that happens to look similar.
 *
 * One currency failing does not stop the others: a feed missing Polish złoty
 * should not leave the euro list a day stale as well. Each currency's own
 * transaction is all-or-nothing.
 */
export async function refreshConvertedPrices(
  trigger: 'schedule' | 'manual',
  actorId: string | null,
): Promise<FxRefreshResult> {
  const settings = await getFxRateSettings();
  const baseCurrency = await getBaseCurrency();

  const finish = async (result: FxRefreshResult): Promise<FxRefreshResult> => {
    await prisma.currencyRateSync.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        lastRunAt: new Date(),
        lastRunStatus: result.status,
        lastRunMessage: result.message.slice(0, 512),
        lastRunUpdated: result.updated,
      },
      update: {
        lastRunAt: new Date(),
        lastRunStatus: result.status,
        lastRunMessage: result.message.slice(0, 512),
        lastRunUpdated: result.updated,
      },
    });

    logger.info({ trigger, ...result, currencies: undefined }, 'exchange rate refresh finished');
    return result;
  };

  const currencies = await managedCurrencies(baseCurrency);

  if (currencies.length === 0) {
    return finish({
      status: 'skipped',
      message:
        'No market is maintained by exchange rate yet. Fill one in from Products → Currency pricing first.',
      baseCurrency,
      currencies: [],
      updated: 0,
    });
  }

  // Bring in a new rate set first, then price from whatever is live.
  //
  // Two steps rather than one, and kept in this order on purpose. If the fetch
  // fails, the previously activated set is still there and still usable, so a
  // feed outage costs the deployment nothing at all - where before it cost the
  // whole run. The refresh result is reported either way.
  const snapshot = await refreshRateSnapshot(trigger);
  const rates = await fetchRates(baseCurrency);

  if (rates === null) {
    // No usable set at all: never fetched, or every fetch so far refused. The
    // catalogue stays exactly as it is, which is the only safe answer.
    return finish({
      status: 'failed',
      message:
        snapshot.status === 'failed' || snapshot.status === 'rejected'
          ? snapshot.message
          : 'There is no usable exchange rate set yet, so no price was changed.',
      baseCurrency,
      currencies: [],
      updated: 0,
    });
  }

  const results: FxRefreshCurrency[] = [];
  let updated = 0;

  for (const currency of currencies) {
    const rate = rates.get(currency);

    if (rate === undefined) {
      results.push({
        currency,
        rate: '',
        updated: 0,
        skipped: 0,
        maxDriftPercent: null,
        error: `The rate feed does not quote ${currency}.`,
      });
      continue;
    }

    const withMargin = applyMargin(rate, settings.marginPercent);

    try {
      const run: BulkPriceResult = await bulkPriceFromCurrency(
        {
          sourceCurrency: baseCurrency,
          targetCurrency: currency,
          rate: withMargin,
          rounding: settings.rounding,
          overwriteExisting: true,
          autoManaged: true,
          restrictToAutoManaged: true,
          maxDriftPercent: settings.maxDriftPercent,
        },
        baseCurrency,
        actorId,
        true,
      );

      updated += run.written;
      results.push({
        currency,
        rate: withMargin,
        updated: run.written,
        skipped: run.skippedExisting,
        maxDriftPercent: run.maxDriftPercent,
        error: null,
      });
    } catch (cause) {
      results.push({
        currency,
        rate: withMargin,
        updated: 0,
        skipped: 0,
        maxDriftPercent: null,
        error: cause instanceof Error ? cause.message : 'The refresh failed.',
      });
    }
  }

  const failures = results.filter((row) => row.error !== null);

  return finish({
    status: failures.length === results.length ? 'failed' : 'ok',
    message:
      failures.length === 0
        ? `${String(updated)} prices updated across ${String(results.length)} currencies.`
        : `${String(updated)} prices updated. ${failures
            .map((row) => `${row.currency}: ${row.error ?? ''}`)
            .join(' ')}`,
    baseCurrency,
    currencies: results,
    updated,
  });
}

/**
 * The settings screen's "Refresh now".
 *
 * Refuses only when NEITHER feature needs rates. The check used to be on
 * `isEnabled` alone, which made the button unreachable for a deployment that
 * wants read-time conversion without letting a job rewrite its price rows -
 * a perfectly reasonable configuration, and one where fetching rates is the
 * only thing that matters.
 *
 * With rewriting off it fetches and activates a rate set and touches no price;
 * with rewriting on it does both, by the same code path the scheduler uses, so
 * the button remains a real rehearsal of tonight's run rather than a second
 * implementation that resembles it.
 */
export async function refreshNow(actorId: string | null): Promise<FxRefreshResult> {
  const settings = await getFxRateSettings();

  if (!settings.isEnabled && !settings.deriveMissingPrices) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Turn on automatic price updates or automatic conversion before fetching rates.',
      [{ field: 'isEnabled', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  if (!settings.isEnabled) {
    const snapshot = await refreshRateSnapshot('manual');
    const baseCurrency = await getBaseCurrency();

    return {
      status: snapshot.status === 'failed' || snapshot.status === 'rejected' ? 'failed' : 'ok',
      message: snapshot.message,
      baseCurrency,
      currencies: [],
      updated: 0,
    };
  }

  return refreshConvertedPrices('manual', actorId);
}
