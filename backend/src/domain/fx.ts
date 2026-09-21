/**
 * Exchange rates, as arithmetic.
 *
 * This module is pure. It knows nothing about providers, HTTP, Prisma or
 * settings; it turns a set of quoted rates into the one number a conversion
 * needs, and refuses to produce a number it cannot stand behind.
 *
 * THREE RULES, AND THEY ARE THE WHOLE MODULE
 *
 *   - **No floats, ever.** A rate arrives as a decimal string and stays one.
 *     `Number('0.011')` is already wrong before anything is multiplied by it,
 *     and a catalogue-wide price list is the last place to find that out. Every
 *     operation here is bigint arithmetic on a fixed scale.
 *
 *   - **One pivot.** Feeds quote against a single base - the European Central
 *     Bank quotes against the euro and nothing else - so PLN -> INR is not a
 *     rate anybody publishes. It is `EUR->INR` divided by `EUR->PLN`, and doing
 *     that division in one place is what stops two callers disagreeing about
 *     a zloty.
 *
 *   - **Age is part of the rate.** A rate with no timestamp is not a rate, it
 *     is a number. Every function that hands one out also says how old it is,
 *     and the callers that take money decide separately from the callers that
 *     render a page.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not round to minor units. That is `bulk-price.service.ts`'s
 * `conversionFor`/`convert`, which already folds both currencies' exponents and
 * the deployment's rounding rule into integer arithmetic. A second
 * implementation of "what does this cost" is exactly the thing the project
 * guide forbids, so this module stops at the rate and hands it over.
 */

/**
 * Decimal places every stored and computed rate carries.
 *
 * Twelve, not eight. Eight is enough to *quote* any pair - `conversionFor`
 * accepts eight and no currency needs more - but a cross-rate is a division,
 * and dividing two eight-place numbers while keeping eight places loses a digit
 * every time. Twelve gives the division four places of headroom so the result
 * is still exact to the eight that get used.
 *
 * It must stay in step with `Decimal(24, 12)` on `exchange_rates.rate`.
 */
export const RATE_SCALE_DP = 12;
const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DP);

/** Decimal places a rate is handed to `conversionFor` with. */
export const QUOTE_DP = 8;

/**
 * Why a conversion could not be produced.
 *
 * A closed set rather than a message, because the caller's response differs per
 * member: a missing pair is a catalogue gap somebody fills, a stale set is an
 * operations alert, and a malformed rate is a provider fault. Collapsing them
 * into "unavailable" would make all three look like the first.
 */
export type FxUnavailableReason =
  | 'NO_RATE_SET'
  | 'PAIR_NOT_QUOTED'
  | 'RATE_TOO_OLD'
  | 'RATE_MALFORMED';

export class FxError extends Error {
  readonly reason: FxUnavailableReason;

  constructor(reason: FxUnavailableReason, message: string) {
    super(message);
    this.name = 'FxError';
    this.reason = reason;
  }
}

/** One quoted rate: how many `quoteCurrency` one `baseCurrency` buys. */
export interface QuotedRate {
  baseCurrency: string;
  quoteCurrency: string;
  /** Decimal string, up to `RATE_SCALE_DP` places. Always greater than zero. */
  rate: string;
  /** When the provider says the rate applies. */
  asOf: Date;
}

/**
 * A usable set of rates, all sharing one pivot currency.
 *
 * `asOf` belongs to the set, not to a row: a provider publishes a whole list
 * for a date, and mixing yesterday's zloty with today's dollar would produce a
 * cross-rate that never existed.
 */
export interface RateSet {
  pivotCurrency: string;
  asOf: Date;
  /** Quote currency (upper case) -> decimal string, one pivot unit buys this. */
  rates: ReadonlyMap<string, string>;
  /** Identifies the stored snapshot this came from, for the order record. */
  snapshotId: string | null;
  provider: string;
}

/** A rate ready to be handed to `conversionFor`, with its provenance attached. */
export interface ResolvedRate {
  fromCurrency: string;
  toCurrency: string;
  /** Mid-market, before any configured adjustment. `QUOTE_DP` places. */
  midRate: string;
  /** `midRate` with the deployment's adjustment applied. `QUOTE_DP` places. */
  rate: string;
  /** The adjustment that was applied, as a percent string. "0.00" when none. */
  adjustmentPercent: string;
  pivotCurrency: string;
  asOf: Date;
  snapshotId: string | null;
  provider: string;
  ageMs: number;
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic
// ---------------------------------------------------------------------------

/** Half-up division of two bigints. The one rounding policy in this project. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new FxError('RATE_MALFORMED', 'Division by zero in a rate.');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

/**
 * Parse a decimal rate string to a bigint scaled by `RATE_SCALE_DP`.
 *
 * Strict on purpose. A provider that answers with `"1,0523"`, `"1e-3"` or an
 * HTML error page parsed as text should fail here, loudly, rather than become
 * a price. Exponent notation is rejected rather than handled: no rate feed
 * uses it, and accepting it would mean accepting `Number()` somewhere.
 */
export function parseRate(value: string): bigint {
  const trimmed = value.trim();

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new FxError('RATE_MALFORMED', `Not a plain decimal rate: ${value}`);
  }

  const [whole = '0', fraction = ''] = trimmed.split('.');
  const scaledFraction = fraction.padEnd(RATE_SCALE_DP, '0').slice(0, RATE_SCALE_DP);
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(scaledFraction || '0');

  if (scaled <= 0n) {
    throw new FxError('RATE_MALFORMED', `A rate must be greater than zero (got ${value})`);
  }

  return scaled;
}

/** A scaled bigint back to a decimal string with `dp` places. */
export function formatRate(scaled: bigint, dp: number = RATE_SCALE_DP): string {
  if (dp > RATE_SCALE_DP) throw new FxError('RATE_MALFORMED', 'Cannot invent precision.');

  const reduced =
    dp === RATE_SCALE_DP ? scaled : divideRoundHalfUp(scaled, 10n ** BigInt(RATE_SCALE_DP - dp));

  if (dp === 0) return reduced.toString();

  const unit = 10n ** BigInt(dp);
  const whole = reduced / unit;
  const fraction = reduced % unit;

  return `${whole.toString()}.${fraction.toString().padStart(dp, '0')}`;
}

/**
 * Is this a rate string this module will accept?
 *
 * Used by the provider validation step, which wants to drop one bad row rather
 * than abandon a whole feed, so it needs to ask without catching.
 */
export function isUsableRate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    parseRate(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cross rates
// ---------------------------------------------------------------------------

/**
 * The rate from one currency to another, through the set's pivot.
 *
 * Four cases, and the last is the one the European Central Bank makes
 * unavoidable:
 *
 *   1. Same currency  -> exactly 1. Never looked up, never rounded.
 *   2. Pivot -> X     -> the quoted rate.
 *   3. X -> pivot     -> the reciprocal.
 *   4. X -> Y         -> `pivot->Y` divided by `pivot->X`.
 *
 * Case 4 is computed in one division at full scale rather than as two
 * roundings, so PLN -> INR and INR -> PLN stay reciprocals of each other to
 * every place anybody uses.
 */
export function crossRate(from: string, to: string, set: RateSet): string {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  const pivot = set.pivotCurrency.toUpperCase();

  if (source === target) return formatRate(RATE_SCALE);

  const quoteFor = (code: string): bigint => {
    if (code === pivot) return RATE_SCALE;

    const quoted = set.rates.get(code);
    if (quoted === undefined) {
      throw new FxError(
        'PAIR_NOT_QUOTED',
        `${set.provider} does not quote ${code} against ${pivot}.`,
      );
    }

    return parseRate(quoted);
  };

  const sourceScaled = quoteFor(source);
  const targetScaled = quoteFor(target);

  // One division at full scale. Doing it as `(1/source) * target` would round
  // twice and leave the pair disagreeing with its own reciprocal.
  return formatRate(divideRoundHalfUp(targetScaled * RATE_SCALE, sourceScaled));
}

/**
 * `1 / rate`, exactly, half-up.
 *
 * Needed for one thing: an order charged in a converted currency records what
 * it was worth in the base currency, and that is the charged total divided by
 * the rate rather than the base-currency line prices added back up. Rebuilding
 * it from individually rounded lines would land a minor unit or two away from
 * the charged figure and nothing would reconcile the difference.
 *
 * The inverse of a rate is very often a recurring decimal, so this rounds
 * rather than truncates - truncation would bias every such order the same
 * direction, which over enough orders is a real number.
 */
export function invertRate(rate: string, dp: number = RATE_SCALE_DP): string {
  return formatRate(divideRoundHalfUp(RATE_SCALE * RATE_SCALE, parseRate(rate)), dp);
}

/**
 * `rate * (1 + percent/100)`, exactly.
 *
 * The percent arrives as a decimal string from `Decimal(5,2)` and is parsed as
 * a fraction, not with `Number()`. The implementation this replaces used
 * `Math.round(Number(percent) * 100)` - a float in a money path, and the kind
 * of thing kept out of every other calculation in this project.
 *
 * A negative percent is legal and means the deployment quotes below mid-market.
 */
export function applyAdjustment(rate: string, percent: string): string {
  const trimmed = percent.trim();

  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new FxError('RATE_MALFORMED', `Not a plain decimal percentage: ${percent}`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  // Two places, matching Decimal(5,2). 10_000 = 100% at that scale.
  const scaledPercent = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2) || '0');
  const signedPercent = negative ? -scaledPercent : scaledPercent;

  if (signedPercent <= -10_000n) {
    throw new FxError('RATE_MALFORMED', 'An adjustment cannot remove the whole rate.');
  }

  const adjusted = divideRoundHalfUp(parseRate(rate) * (10_000n + signedPercent), 10_000n);
  return formatRate(adjusted);
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * How stale a rate set is allowed to be, per purpose.
 *
 * Two numbers rather than one, because a catalogue page and a card charge are
 * not the same risk. A price list rendered from a rate that is three days old
 * over a long weekend is a marked approximation somebody can still choose to
 * buy at; a payment taken on one is a number nobody can reconcile afterwards.
 * The checkout window is therefore separate, and the caller says which one it
 * is asking about.
 */
export interface FreshnessPolicy {
  /** Maximum age for a figure shown on a page. */
  displayMaxAgeMs: number;
  /** Maximum age for a figure a payment will be taken against. */
  checkoutMaxAgeMs: number;
}

export type FxPurpose = 'display' | 'checkout';

export function rateAgeMs(asOf: Date, now: Date = new Date()): number {
  return Math.max(0, now.getTime() - asOf.getTime());
}

/**
 * Is a set fresh enough for this purpose?
 *
 * Note what is NOT here: any notion of weekends or bank holidays. The European
 * Central Bank publishes on working days, so a Sunday rate is legitimately
 * Friday's and is two days old - which the display window is sized for. Trying
 * to "correct" for that by treating a weekend as zero elapsed time would mean a
 * provider that genuinely stopped publishing on a Friday still looked healthy
 * on Monday, which is the failure this check exists to catch.
 */
export function isFreshEnough(
  asOf: Date,
  purpose: FxPurpose,
  policy: FreshnessPolicy,
  now: Date = new Date(),
): boolean {
  const limit = purpose === 'checkout' ? policy.checkoutMaxAgeMs : policy.displayMaxAgeMs;
  return rateAgeMs(asOf, now) <= limit;
}

/**
 * Resolve a pair into a rate ready for `conversionFor`, or refuse.
 *
 * The single entry point the rest of the system uses. It returns the mid rate
 * and the adjusted one side by side, because the order snapshot records both:
 * "what the market said" and "what we quoted against it" are different facts,
 * and a settlement dispute needs each of them.
 */
export function resolveRate(
  from: string,
  to: string,
  set: RateSet,
  options: {
    purpose: FxPurpose;
    policy: FreshnessPolicy;
    adjustmentPercent?: string;
    now?: Date;
  },
): ResolvedRate {
  const now = options.now ?? new Date();

  if (!isFreshEnough(set.asOf, options.purpose, options.policy, now)) {
    const limit =
      options.purpose === 'checkout'
        ? options.policy.checkoutMaxAgeMs
        : options.policy.displayMaxAgeMs;

    throw new FxError(
      'RATE_TOO_OLD',
      `The ${set.provider} rate set is from ${set.asOf.toISOString()}, older than the ${String(
        Math.round(limit / 3_600_000),
      )} hour limit for ${purposeLabel(options.purpose)}.`,
    );
  }

  const source = from.toUpperCase();
  const target = to.toUpperCase();
  const midFull = crossRate(source, target, set);
  const adjustmentPercent = options.adjustmentPercent ?? '0.00';

  // Same currency is never adjusted. A spread on INR -> INR would charge a
  // customer for a conversion that did not happen.
  const adjustedFull = source === target ? midFull : applyAdjustment(midFull, adjustmentPercent);

  return {
    fromCurrency: source,
    toCurrency: target,
    midRate: formatRate(parseRate(midFull), QUOTE_DP),
    rate: formatRate(parseRate(adjustedFull), QUOTE_DP),
    adjustmentPercent: source === target ? '0.00' : adjustmentPercent,
    pivotCurrency: set.pivotCurrency.toUpperCase(),
    asOf: set.asOf,
    snapshotId: set.snapshotId,
    provider: set.provider,
    ageMs: rateAgeMs(set.asOf, now),
  };
}

function purposeLabel(purpose: FxPurpose): string {
  return purpose === 'checkout' ? 'checkout' : 'display';
}
