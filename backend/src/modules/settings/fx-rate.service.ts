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
import { env } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  bulkPriceFromCurrency,
  type BulkPriceResult,
  type PriceRounding,
} from '../catalog/bulk-price.service.js';
import { getBaseCurrency } from './currency.service.js';

/**
 * One settings row, addressed by a fixed id.
 *
 * A singleton table rather than a key-value store: every field here is typed,
 * and a percentage that arrives as the string "abc" should fail at the column
 * rather than three layers later in bigint arithmetic.
 */
const SETTINGS_ID = '00000000000000000000000000';

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
}

export interface FxRateSettingsInput {
  isEnabled?: boolean;
  marginPercent?: string;
  rounding?: PriceRounding;
  maxDriftPercent?: string;
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
  };
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
 * Today's rates against the base currency.
 *
 * Deliberately tolerant of the shape and strict about the values: any feed
 * that answers with `{ rates: { EUR: 0.0105 } }` works, which is most of them,
 * and a rate that is not a finite positive number is dropped rather than
 * written into a price. `{base}` in the configured URL is substituted so a
 * self-hosted deployment can point at its own mirror.
 */
export async function fetchRates(base: string): Promise<Map<string, string>> {
  const url = env.FX_RATE_URL.replace('{base}', encodeURIComponent(base));

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(env.FX_RATE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`The rate feed answered ${String(response.status)}.`);
  }

  const body: unknown = await response.json();

  const rates =
    typeof body === 'object' && body !== null && 'rates' in body
      ? (body).rates
      : null;

  if (typeof rates !== 'object' || rates === null) {
    throw new Error('The rate feed returned no rates.');
  }

  const parsed = new Map<string, string>();

  for (const [code, value] of Object.entries(rates as Record<string, unknown>)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;

    // Back to a decimal string immediately: everything downstream is exact
    // integer arithmetic, and a float must not survive past this boundary.
    // Eight places is what `conversionFor` accepts and far past what any
    // currency pair needs.
    parsed.set(code.toUpperCase(), value.toFixed(8));
  }

  if (parsed.size === 0) throw new Error('The rate feed returned no usable rates.');

  return parsed;
}

/** `rate * (1 + margin/100)`, kept exact and clamped to 8 decimal places. */
export function applyMargin(rate: string, marginPercent: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(8, '0').slice(0, 8));

  const margin = BigInt(Math.round(Number(marginPercent) * 100));
  const withMargin = (scaled * (10_000n + margin)) / 10_000n;

  const text = withMargin.toString().padStart(9, '0');
  return `${text.slice(0, -8)}.${text.slice(-8)}`;
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

  let rates: Map<string, string>;

  try {
    rates = await fetchRates(baseCurrency);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The rate feed could not be reached.';

    // A feed being down is not a reason to change any price. The catalogue
    // simply stays as it is until the next run.
    return finish({
      status: 'failed',
      message,
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

/** The settings screen's "Refresh now". Refuses when the feature is off. */
export async function refreshNow(actorId: string | null): Promise<FxRefreshResult> {
  const settings = await getFxRateSettings();

  if (!settings.isEnabled) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Turn automatic exchange rate updates on before running one.',
      [{ field: 'isEnabled', code: ErrorCode.VALIDATION_FAILED }],
    );
  }

  return refreshConvertedPrices('manual', actorId);
}
