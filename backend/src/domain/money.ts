/**
 * Money.
 *
 * Every amount in this system is an integer count of the currency's minor unit
 * (paise for INR, cents for USD) carried as a `bigint`. There is no `number`
 * representation of money anywhere, because 0.1 + 0.2 !== 0.3 in IEEE-754 and a
 * cent of drift per line becomes a reconciliation dispute at scale.
 *
 * Tax rates are the one exception: they are exact decimals, handled here as
 * scaled integers so the multiplication stays in integer arithmetic too.
 */

/** Percent values are stored as Decimal(9,6); scale by 1e6 to work in integers. */
const RATE_SCALE = 1_000_000n;

export type Minor = bigint;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Minor units per major unit, by ISO-4217 currency.
 * Only currencies the deployment actually supports are listed - an unknown
 * currency is a configuration error, not something to guess a default for.
 */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  /// The seven EU member states outside the euro. All two-decimal, and all
  /// listed rather than left to be added one crisis at a time: a Swedish
  /// hospital quoted in euro because SEK was missing from this table is a
  /// worse outcome than seven lines here.
  PLN: 2,
  BGN: 2,
  CZK: 2,
  DKK: 2,
  HUF: 2,
  RON: 2,
  SEK: 2,
  /// Zero-decimal currencies. Listed so the rounding helpers stay correct if
  /// the business ever prices in them.
  JPY: 0,
  KRW: 0,
});

export function currencyExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENT[currency.toUpperCase()];
  if (exponent === undefined) {
    throw new MoneyError(`Unsupported currency: ${currency}`);
  }
  return exponent;
}

/** Half-up rounding of a scaled integer division. The documented policy. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;

  // Round away from zero when the remainder is at least half the divisor.
  const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parse a human-entered decimal string ("1499.50") into minor units.
 * Strings, not numbers, are the input type on purpose: a JSON number has
 * already lost precision by the time it reaches this function.
 */
export function parseMajorToMinor(value: string, currency: string): Minor {
  const exponent = currencyExponent(currency);
  const trimmed = value.trim();

  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Invalid money string: ${value}`);
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = '0', fractionPart = ''] = unsigned.split('.');

  // Pad or round the fraction to exactly `exponent` digits.
  let minorFraction: bigint;
  if (fractionPart.length <= exponent) {
    minorFraction = BigInt(fractionPart.padEnd(exponent, '0') || '0');
  } else {
    const keep = fractionPart.slice(0, exponent);
    const nextDigit = Number(fractionPart[exponent] ?? '0');
    minorFraction = BigInt(keep || '0') + (nextDigit >= 5 ? 1n : 0n);
  }

  const scale = 10n ** BigInt(exponent);
  const total = BigInt(wholePart) * scale + minorFraction;
  return negative ? -total : total;
}

/** Format minor units for display or invoices. Never used for arithmetic. */
export function formatMinorToMajor(amount: Minor, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return amount.toString();

  const scale = 10n ** BigInt(exponent);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;

  const whole = absolute / scale;
  const fraction = absolute % scale;

  return `${negative ? '-' : ''}${whole.toString()}.${fraction.toString().padStart(exponent, '0')}`;
}

/**
 * Tax on a line.
 *
 * `ratePercent` arrives as a decimal string from the database (Decimal(9,6)),
 * e.g. "18.000000". It is converted to a scaled integer so the whole
 * calculation stays in bigint arithmetic.
 *
 * Exclusive: tax = base * rate / 100
 * Inclusive: the listed price already contains tax, so
 *            tax = base - base * 100 / (100 + rate)
 */
export function calculateTax(
  baseMinor: Minor,
  ratePercent: string,
  inclusive: boolean,
): { taxMinor: Minor; netMinor: Minor; grossMinor: Minor } {
  if (baseMinor < 0n) throw new MoneyError('Tax base cannot be negative');

  const scaledRate = parseRateToScaled(ratePercent);
  if (scaledRate === 0n) {
    return { taxMinor: 0n, netMinor: baseMinor, grossMinor: baseMinor };
  }

  const hundredScaled = 100n * RATE_SCALE;

  if (inclusive) {
    const netMinor = divideRoundHalfUp(baseMinor * hundredScaled, hundredScaled + scaledRate);
    return { taxMinor: baseMinor - netMinor, netMinor, grossMinor: baseMinor };
  }

  const taxMinor = divideRoundHalfUp(baseMinor * scaledRate, hundredScaled);
  return { taxMinor, netMinor: baseMinor, grossMinor: baseMinor + taxMinor };
}

/** "18.000000" -> 18000000n. Rejects anything that is not an exact decimal. */
export function parseRateToScaled(ratePercent: string): bigint {
  const trimmed = ratePercent.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Invalid tax rate: ${ratePercent}`);
  }

  const [wholePart = '0', fractionPart = ''] = trimmed.split('.');
  const normalisedFraction = fractionPart.slice(0, 6).padEnd(6, '0');
  return BigInt(wholePart) * RATE_SCALE + BigInt(normalisedFraction || '0');
}

/**
 * A percentage of an amount, rounded half-up like every other money operation
 * here.
 *
 * `percent` arrives as an exact decimal string from Decimal(5,2), e.g.
 * "12.50", and is scaled to an integer so the whole calculation stays in
 * bigint. This is the only place a coupon's discount is computed, so its
 * rounding cannot drift from the tax rounding it sits next to.
 */
export function percentOf(amount: Minor, percent: string): Minor {
  if (amount < 0n) throw new MoneyError('Cannot take a percentage of a negative amount');

  const scaled = parseRateToScaled(percent);
  if (scaled === 0n) return 0n;
  if (scaled > 100n * RATE_SCALE) {
    throw new MoneyError(`Percentage cannot exceed 100 (got ${percent})`);
  }

  return divideRoundHalfUp(amount * scaled, 100n * RATE_SCALE);
}

/**
 * Apportion a whole-order discount across lines without losing or inventing a
 * single minor unit. Largest-remainder: floor every share, then hand the
 * leftover units to the lines with the biggest fractional parts.
 */
export function apportion(total: Minor, weights: readonly Minor[]): Minor[] {
  if (total < 0n) throw new MoneyError('Cannot apportion a negative total');
  if (weights.length === 0) return [];

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum <= 0n) {
    // No basis to apportion by: put everything on the first line rather than
    // silently dropping it.
    return weights.map((_, index) => (index === 0 ? total : 0n));
  }

  const shares: Minor[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0n;
    const exact = total * weight;
    const share = exact / weightSum;
    shares.push(share);
    remainders.push({ index, remainder: exact % weightSum });
    allocated += share;
  }

  let leftover = total - allocated;
  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1));

  let cursor = 0;
  while (leftover > 0n && cursor < remainders.length) {
    const target = remainders[cursor];
    if (target) {
      shares[target.index] = (shares[target.index] ?? 0n) + 1n;
      leftover -= 1n;
    }
    cursor += 1;
  }

  return shares;
}

/** Sum with an explicit bigint zero, so an empty list cannot yield `number` 0. */
export function sumMinor(amounts: readonly Minor[]): Minor {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

export function assertNonNegative(amount: Minor, label: string): void {
  if (amount < 0n) throw new MoneyError(`${label} cannot be negative (got ${amount.toString()})`);
}

/**
 * JSON has no bigint. Money crosses the API boundary as a string of minor
 * units plus a formatted display value, never as a JS number.
 */
export function serialiseMoney(
  amount: Minor,
  currency: string,
): { minor: string; formatted: string; currency: string } {
  return {
    minor: amount.toString(),
    formatted: formatMinorToMajor(amount, currency),
    currency,
  };
}
