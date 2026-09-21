/**
 * Fetching, validating and activating a rate set.
 *
 * The job this module exists to do safely: replace the list of rates the whole
 * catalogue is priced from, unattended, at three in the morning, without ever
 * leaving the system in a state where half the prices came from one list and
 * half from another.
 *
 * FOUR PROPERTIES, EACH ONE LOAD-BEARING
 *
 *   - **Validate before activating, never after.** A snapshot is written with
 *     `validationStatus = PENDING` and `isActive = false`, checked against the
 *     currencies this deployment actually uses and against the list it would
 *     replace, and only then activated. A feed that answers promptly with a
 *     decimal shifted one place is not a slow failure - it is an instant
 *     catalogue-wide mispricing, and the previous list staying in place is the
 *     correct outcome.
 *
 *   - **Activation is one transaction and one database constraint.** Retiring
 *     the old snapshot and promoting the new one happen together, and
 *     `uq_fx_snapshot_active_provider` makes "two active at once" impossible
 *     rather than unlikely. Two workers racing produce one winner and one
 *     P2002, not two live rate sets.
 *
 *   - **A bad run costs nothing.** A failed fetch, a rejected validation and a
 *     lost race all leave the previously active snapshot exactly where it was.
 *     There is no partial write: the rates go in with the snapshot, in one
 *     transaction, before anything looks at them.
 *
 *   - **Every outcome is recorded, including the refusals.** A rejected
 *     snapshot is kept, with its reason, because "the feed has been sending
 *     nonsense since Tuesday" is a question somebody asks on Friday and the
 *     only place it can be answered is here.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import {
  FxError,
  formatRate,
  parseRate,
  rateAgeMs,
  type FreshnessPolicy,
  type RateSet,
} from '../../domain/fx.js';
import { logger } from '../../infra/logger.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { createEcbProvider } from './fx/provider.ecb.js';
import { createJsonProvider } from './fx/provider.json.js';
import { RateProviderError, type ProviderRateSet, type RateProvider } from './fx/provider.js';

/**
 * The rounding and conversion rules in force, as a version string.
 *
 * Stamped onto every order that was converted. Bump it when the arithmetic
 * changes - a new rounding mode, a different pivot policy - so an order placed
 * under the old rules is still explainable under them. A date is not enough:
 * it says when, not which.
 */
export const FX_POLICY_VERSION = 'fx-2026-09-1';

/** One settings row, addressed by a fixed id. Shared with `fx-rate.service`. */
export const FX_SETTINGS_ID = '00000000000000000000000000';

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export interface ProviderChoice {
  key: string;
  label: string;
  description: string;
  pivotCurrency: string;
}

/**
 * What an administrator may choose between.
 *
 * A closed list, not free text. The provider decides where the server makes an
 * outbound request to, and "any URL an admin types" is a server-side request
 * forgery waiting to happen - which is why `FX_RATE_URL` and `FX_ECB_URL` are
 * environment variables and this is a key that selects between them.
 */
export function availableProviders(): ProviderChoice[] {
  return [createEcbProvider(env.FX_ECB_URL), createJsonProvider(env.FX_RATE_URL, 'EUR')].map(
    (provider) => ({
      key: provider.name,
      label: provider.name === 'ecb' ? 'European Central Bank' : 'Configured JSON feed',
      description: provider.description,
      pivotCurrency: provider.pivotCurrency,
    }),
  );
}

export function providerFor(key: string, pivotCurrency: string): RateProvider {
  if (key === 'ecb') return createEcbProvider(env.FX_ECB_URL);
  return createJsonProvider(env.FX_RATE_URL, pivotCurrency);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationOutcome {
  ok: boolean;
  reason: string | null;
  maxDriftPercent: string | null;
  maxDriftCurrency: string | null;
}

/**
 * Is this list fit to price with?
 *
 * Three questions, in the order a person would ask them.
 *
 * 1. **Does it cover what we sell in?** A list that is missing the currencies
 *    this deployment actually prices in is not usable, whatever else is right
 *    about it. Missing ONE currency is not fatal - the ECB does not quote the
 *    dirham and never will, and that market simply keeps its manual prices -
 *    but a list that covers none of them is a wrong feed, not a gap.
 *
 * 2. **Has anything moved further than a currency moves?** Compared against
 *    the list this would replace, per currency. `maxDriftPercent` is the guard
 *    that catches a wrong base, a shifted decimal, or an error body that
 *    happened to parse. The comparison is per currency and the verdict is for
 *    the whole list: one bad rate means the list is wrong, not that one
 *    currency is.
 *
 * 3. **Is it going backwards?** A provider re-serving a cached older document
 *    would otherwise quietly un-update the catalogue. An older `asOf` than the
 *    active snapshot is refused - not because the rates are wrong, but because
 *    accepting it would make "which list is live" depend on fetch order.
 *
 * Deliberately NOT checked: whether the rates look "reasonable" in absolute
 * terms. There is no honest constant for that. A currency can genuinely move
 * thirty percent in a day, and a system that silently refuses to believe it is
 * worse than one that flags it and asks.
 */
export function validateRateSet(
  candidate: ProviderRateSet,
  options: {
    requiredCurrencies: readonly string[];
    previous: ReadonlyMap<string, string> | null;
    previousAsOf: Date | null;
    maxDriftPercent: string;
  },
): ValidationOutcome {
  const required = options.requiredCurrencies
    .map((code) => code.toUpperCase())
    .filter((code) => code !== candidate.pivotCurrency.toUpperCase());

  if (required.length > 0) {
    const covered = required.filter((code) => candidate.rates.has(code));

    if (covered.length === 0) {
      return {
        ok: false,
        reason:
          `The feed quotes none of the currencies this shop prices in ` +
          `(${required.join(', ')}). That is a wrong feed, not a gap.`,
        maxDriftPercent: null,
        maxDriftCurrency: null,
      };
    }
  }

  if (options.previousAsOf !== null && candidate.asOf.getTime() < options.previousAsOf.getTime()) {
    return {
      ok: false,
      reason:
        `The feed returned rates for ${candidate.asOf.toISOString().slice(0, 10)}, which is older ` +
        `than the ${options.previousAsOf.toISOString().slice(0, 10)} set already in use.`,
      maxDriftPercent: null,
      maxDriftCurrency: null,
    };
  }

  if (options.previous === null || options.previous.size === 0) {
    // Nothing to compare against. The first snapshot is accepted on its own
    // terms - refusing it would mean a new deployment could never get started.
    return { ok: true, reason: null, maxDriftPercent: null, maxDriftCurrency: null };
  }

  const limit = parseRate(options.maxDriftPercent === '0' ? '0.00000001' : options.maxDriftPercent);
  let worst = 0n;
  let worstCurrency: string | null = null;

  for (const [code, value] of candidate.rates) {
    const before = options.previous.get(code);
    if (before === undefined) continue;

    const beforeScaled = parseRate(before);
    const afterScaled = parseRate(value);
    const delta = afterScaled > beforeScaled ? afterScaled - beforeScaled : beforeScaled - afterScaled;

    // Percentage move, kept in scaled integer arithmetic throughout.
    const driftScaled = (delta * 100n * 10n ** 12n) / beforeScaled;

    if (driftScaled > worst) {
      worst = driftScaled;
      worstCurrency = code;
    }
  }

  const worstPercent = formatRate(worst, 4);

  if (worst > limit) {
    return {
      ok: false,
      reason:
        `${worstCurrency ?? 'A currency'} moved ${worstPercent}% against the set already in use, ` +
        `past the ${options.maxDriftPercent}% limit. Nothing was changed.`,
      maxDriftPercent: worstPercent,
      maxDriftCurrency: worstCurrency,
    };
  }

  return { ok: true, reason: null, maxDriftPercent: worstPercent, maxDriftCurrency: worstCurrency };
}

// ---------------------------------------------------------------------------
// Reading the active set
// ---------------------------------------------------------------------------

/**
 * The live rate set, or null when there is none.
 *
 * Null is a real answer and every caller handles it: a deployment that has
 * never fetched rates, or whose feed has been refused for a week, has no rate
 * set, and the correct behaviour is to show nothing rather than to invent a
 * number. This function never falls back to a retired snapshot - an expired
 * rate that is presented as current is the failure mode this whole module is
 * built to avoid.
 */
export async function activeRateSet(provider?: string): Promise<RateSet | null> {
  const row = await prisma.exchangeRateSnapshot.findFirst({
    where: {
      isActive: true,
      validationStatus: 'VALID',
      ...(provider === undefined ? {} : { provider }),
    },
    include: { rates: { select: { quoteCurrency: true, rate: true } } },
    orderBy: { asOf: 'desc' },
  });

  if (row === null) return null;

  const rates = new Map<string, string>();
  for (const rate of row.rates) rates.set(rate.quoteCurrency, rate.rate.toFixed(12));

  return {
    pivotCurrency: row.pivotCurrency,
    asOf: row.asOf,
    rates,
    snapshotId: row.id,
    provider: row.provider,
  };
}

export interface FxHealth {
  provider: string;
  hasActiveSet: boolean;
  asOf: string | null;
  ageHours: number | null;
  /// True when the set is past `alertMaxAgeHours` and somebody should look.
  stale: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  alertMaxAgeHours: number;
  deriveMissingPrices: boolean;
}

export async function fxHealth(): Promise<FxHealth> {
  const settings = await prisma.currencyRateSync.upsert({
    where: { id: FX_SETTINGS_ID },
    create: { id: FX_SETTINGS_ID },
    update: {},
  });

  const set = await activeRateSet(settings.provider);
  const ageMs = set === null ? null : rateAgeMs(set.asOf);

  return {
    provider: settings.provider,
    hasActiveSet: set !== null,
    asOf: set?.asOf.toISOString() ?? null,
    ageHours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
    stale: ageMs === null || ageMs > settings.alertMaxAgeHours * 3_600_000,
    lastSuccessAt: settings.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: settings.lastFailureAt?.toISOString() ?? null,
    consecutiveFailures: settings.consecutiveFailures,
    lastRunStatus: settings.lastRunStatus,
    lastRunMessage: settings.lastRunMessage,
    displayMaxAgeHours: settings.displayMaxAgeHours,
    checkoutMaxAgeHours: settings.checkoutMaxAgeHours,
    alertMaxAgeHours: settings.alertMaxAgeHours,
    deriveMissingPrices: settings.deriveMissingPrices,
  };
}

export interface RateSnapshotSummary {
  id: string;
  provider: string;
  pivotCurrency: string;
  asOf: string;
  fetchedAt: string;
  sourceReference: string;
  retrievalStatus: string;
  validationStatus: string;
  failureReason: string | null;
  rateCount: number;
  rejectedCount: number;
  maxDriftPercent: string | null;
  maxDriftCurrency: string | null;
  isActive: boolean;
}

/**
 * The recent history, newest first.
 *
 * Includes the refusals and the unreachable attempts on purpose. "The feed has
 * been sending nonsense since Tuesday" is a question somebody asks on Friday,
 * and a list that only showed successes could not answer it.
 */
export async function listRateSnapshots(limit = 20): Promise<RateSnapshotSummary[]> {
  const rows = await prisma.exchangeRateSnapshot.findMany({
    orderBy: { fetchedAt: 'desc' },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    pivotCurrency: row.pivotCurrency,
    asOf: row.asOf.toISOString(),
    fetchedAt: row.fetchedAt.toISOString(),
    sourceReference: row.sourceReference,
    retrievalStatus: row.retrievalStatus,
    validationStatus: row.validationStatus,
    failureReason: row.failureReason,
    rateCount: row.rateCount,
    rejectedCount: row.rejectedCount,
    maxDriftPercent: row.maxDriftPercent?.toFixed(4) ?? null,
    maxDriftCurrency: row.maxDriftCurrency,
    isActive: row.isActive,
  }));
}

export function freshnessPolicyFrom(settings: {
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
}): FreshnessPolicy {
  return {
    displayMaxAgeMs: settings.displayMaxAgeHours * 3_600_000,
    checkoutMaxAgeMs: settings.checkoutMaxAgeHours * 3_600_000,
  };
}

// ---------------------------------------------------------------------------
// The refresh
// ---------------------------------------------------------------------------

export interface SnapshotRefreshResult {
  status: 'activated' | 'unchanged' | 'rejected' | 'failed';
  message: string;
  snapshotId: string | null;
  provider: string;
  asOf: string | null;
  rateCount: number;
  rejectedCount: number;
  maxDriftPercent: string | null;
  attempts: number;
}

/** Full jitter exponential backoff. Bounded, and never zero. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(env.FX_RATE_RETRY_BASE_MS * 2 ** (attempt - 1), 30_000);
  return Math.max(50, Math.floor(Math.random() * ceiling));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch, retrying only what is worth retrying.
 *
 * A 404 or a malformed document is a configuration fault: the same request
 * will fail the same way in two seconds, and hammering it only delays the
 * honest "this is broken" by the length of the backoff. A timeout or a 503 is
 * worth another go. `RateProviderError.retryable` carries that distinction
 * from the place that knows it.
 */
async function fetchWithRetries(
  provider: RateProvider,
): Promise<{ set: ProviderRateSet; attempts: number }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= env.FX_RATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const set = await provider.fetch({ timeoutMs: env.FX_RATE_TIMEOUT_MS });
      return { set, attempts: attempt };
    } catch (cause) {
      lastError = cause;

      const retryable = cause instanceof RateProviderError ? cause.retryable : false;
      if (!retryable || attempt === env.FX_RATE_MAX_ATTEMPTS) break;

      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new RateProviderError('The rate feed could not be reached.', true);
}

/**
 * Which currencies this deployment needs quoted.
 *
 * The active currency list, which is the set a shopper can actually choose
 * between. Not "every currency with a price row": a currency priced entirely
 * by hand still needs a rate if anybody is ever to see a derived figure in it,
 * and a currency nobody can select does not need one at all.
 */
async function requiredCurrencies(): Promise<string[]> {
  const rows = await prisma.currency.findMany({
    where: { isActive: true },
    select: { code: true },
  });

  return rows.map((row) => row.code);
}

/**
 * Fetch a rate set and, if it stands up, make it the live one.
 *
 * Returns rather than throws for every ordinary failure. A scheduled job that
 * throws is a stack trace in a log; one that returns a status is a sentence on
 * the settings screen, and the person who needs to know is looking at the
 * screen.
 */
export async function refreshRateSnapshot(
  trigger: 'schedule' | 'manual',
): Promise<SnapshotRefreshResult> {
  const settings = await prisma.currencyRateSync.upsert({
    where: { id: FX_SETTINGS_ID },
    create: { id: FX_SETTINGS_ID },
    update: {},
  });

  const provider = providerFor(settings.provider, 'EUR');

  const recordFailure = async (message: string): Promise<void> => {
    await prisma.currencyRateSync.update({
      where: { id: FX_SETTINGS_ID },
      data: {
        lastFailureAt: new Date(),
        consecutiveFailures: { increment: 1 },
        lastRunAt: new Date(),
        lastRunStatus: 'failed',
        lastRunMessage: message.slice(0, 512),
      },
    });
  };

  let fetched: { set: ProviderRateSet; attempts: number };

  try {
    fetched = await fetchWithRetries(provider);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'The rate feed could not be reached.';

    // The failed attempt is recorded as a snapshot row too. A feed that has
    // been unreachable for two days is a fact with a shape, and a settings
    // screen that can only say "last run failed" cannot show it.
    await prisma.exchangeRateSnapshot.create({
      data: {
        id: newId(),
        provider: provider.name,
        pivotCurrency: provider.pivotCurrency,
        asOf: new Date(),
        sourceReference: `${provider.name}:unreachable`,
        retrievalStatus: 'FAILED',
        validationStatus: 'REJECTED',
        failureReason: message.slice(0, 512),
      },
    });

    await recordFailure(message);

    return {
      status: 'failed',
      message,
      snapshotId: null,
      provider: provider.name,
      asOf: null,
      rateCount: 0,
      rejectedCount: 0,
      maxDriftPercent: null,
      attempts: env.FX_RATE_MAX_ATTEMPTS,
    };
  }

  const candidate = fetched.set;
  const active = await activeRateSet(provider.name);

  // An unchanged document is the ordinary weekend case, not a failure. The
  // ECB publishes on working days; fetching on Sunday returns Friday's list
  // with Friday's date, and re-activating it would only churn rows.
  if (active !== null && active.asOf.getTime() === candidate.asOf.getTime()) {
    await prisma.currencyRateSync.update({
      where: { id: FX_SETTINGS_ID },
      data: {
        lastSuccessAt: new Date(),
        consecutiveFailures: 0,
        lastRunAt: new Date(),
        lastRunStatus: 'skipped',
        lastRunMessage: `The feed still publishes ${candidate.asOf
          .toISOString()
          .slice(0, 10)}, which is already in use.`,
      },
    });

    return {
      status: 'unchanged',
      message: `Already using the ${candidate.asOf.toISOString().slice(0, 10)} rates.`,
      snapshotId: active.snapshotId,
      provider: provider.name,
      asOf: candidate.asOf.toISOString(),
      rateCount: candidate.rates.size,
      rejectedCount: candidate.rejectedCount,
      maxDriftPercent: null,
      attempts: fetched.attempts,
    };
  }

  const verdict = validateRateSet(candidate, {
    requiredCurrencies: await requiredCurrencies(),
    previous: active?.rates ?? null,
    previousAsOf: active?.asOf ?? null,
    maxDriftPercent: settings.maxDriftPercent.toFixed(2),
  });

  const snapshotId = newId();

  const snapshotData = {
    id: snapshotId,
    provider: candidate.provider,
    pivotCurrency: candidate.pivotCurrency,
    asOf: candidate.asOf,
    sourceReference: candidate.sourceReference.slice(0, 512),
    retrievalStatus: 'FETCHED' as const,
    rateCount: candidate.rates.size,
    rejectedCount: candidate.rejectedCount,
    maxDriftPercent: verdict.maxDriftPercent,
    maxDriftCurrency: verdict.maxDriftCurrency,
  };

  if (!verdict.ok) {
    // Kept, with its reason, and never activated. The rates go in too: "what
    // exactly did the feed send on the day it was refused" is the first
    // question anybody asks about a rejection.
    await prisma.$transaction(async (tx) => {
      await tx.exchangeRateSnapshot.create({
        data: {
          ...snapshotData,
          validationStatus: 'REJECTED',
          failureReason: (verdict.reason ?? 'Refused.').slice(0, 512),
        },
      });

      await writeRates(tx, snapshotId, candidate);
    });

    await recordFailure(verdict.reason ?? 'The rate set was refused.');

    logger.warn(
      { provider: provider.name, snapshotId, reason: verdict.reason },
      'a fetched rate set was refused and the previous one left in place',
    );

    return {
      status: 'rejected',
      message: verdict.reason ?? 'The rate set was refused.',
      snapshotId,
      provider: provider.name,
      asOf: candidate.asOf.toISOString(),
      rateCount: candidate.rates.size,
      rejectedCount: candidate.rejectedCount,
      maxDriftPercent: verdict.maxDriftPercent,
      attempts: fetched.attempts,
    };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Retire first, promote second, both inside this transaction. Doing it
      // the other way round would momentarily have two rows claiming
      // `activeProvider`, which the unique index refuses - correctly, but it
      // would turn an ordinary refresh into a constraint violation.
      await tx.exchangeRateSnapshot.updateMany({
        where: { provider: candidate.provider, activeProvider: { not: null } },
        data: { isActive: false, activeProvider: null, retiredAt: new Date() },
      });

      await tx.exchangeRateSnapshot.create({
        data: {
          ...snapshotData,
          validationStatus: 'VALID',
          isActive: true,
          activeProvider: candidate.provider,
          activatedAt: new Date(),
        },
      });

      await writeRates(tx, snapshotId, candidate);
    });
  } catch (cause) {
    // A P2002 here means another worker activated a set between our read and
    // our write. That is not an error worth alarming about: the other worker's
    // set is just as valid as ours, and one of us had to lose.
    const message = cause instanceof Error ? cause.message : 'The rate set could not be stored.';

    logger.warn(
      { err: cause, provider: provider.name },
      'lost the race to activate a rate set; the other run stands',
    );

    return {
      status: 'unchanged',
      message: `Another run activated a rate set first. ${message}`,
      snapshotId: null,
      provider: provider.name,
      asOf: candidate.asOf.toISOString(),
      rateCount: candidate.rates.size,
      rejectedCount: candidate.rejectedCount,
      maxDriftPercent: verdict.maxDriftPercent,
      attempts: fetched.attempts,
    };
  }

  await prisma.currencyRateSync.update({
    where: { id: FX_SETTINGS_ID },
    data: {
      lastSuccessAt: new Date(),
      consecutiveFailures: 0,
      lastRunAt: new Date(),
      lastRunStatus: 'ok',
      lastRunMessage: `${String(candidate.rates.size)} rates for ${candidate.asOf
        .toISOString()
        .slice(0, 10)} from ${candidate.provider}.`,
    },
  });

  logger.info(
    {
      trigger,
      provider: candidate.provider,
      snapshotId,
      asOf: candidate.asOf.toISOString(),
      rates: candidate.rates.size,
    },
    'a new rate set is live',
  );

  return {
    status: 'activated',
    message: `${String(candidate.rates.size)} rates for ${candidate.asOf
      .toISOString()
      .slice(0, 10)} are now live.`,
    snapshotId,
    provider: candidate.provider,
    asOf: candidate.asOf.toISOString(),
    rateCount: candidate.rates.size,
    rejectedCount: candidate.rejectedCount,
    maxDriftPercent: verdict.maxDriftPercent,
    attempts: fetched.attempts,
  };
}

async function writeRates(
  tx: Prisma.TransactionClient,
  snapshotId: string,
  candidate: ProviderRateSet,
): Promise<void> {
  const rows = [...candidate.rates].map(([quoteCurrency, rate]) => ({
    id: newId(),
    snapshotId,
    baseCurrency: candidate.pivotCurrency,
    quoteCurrency,
    rate,
  }));

  if (rows.length > 0) await tx.exchangeRate.createMany({ data: rows });
}

/**
 * Drop snapshots nobody needs any more.
 *
 * Safe because an order does not depend on the snapshot surviving: it carries
 * its own copy of the rate, the provider and the date. The snapshot is the
 * wider context - the whole list as published - and two years of it is
 * generous. `ON DELETE SET NULL` on the order's link means pruning cannot
 * orphan an order.
 */
export async function pruneRateSnapshots(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.FX_SNAPSHOT_RETENTION_DAYS * 86_400_000);

  const result = await prisma.exchangeRateSnapshot.deleteMany({
    where: { isActive: false, fetchedAt: { lt: cutoff } },
  });

  return result.count;
}

export { FxError };
