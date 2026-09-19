/**
 * The commercial half of a variant: packs, unit pricing and purchasing rules.
 *
 * The distinction this file is built around, because getting it wrong is the
 * most expensive mistake in the whole feature:
 *
 *   **Pack count is part of the product. Cart quantity is not.**
 *
 * "Pack of 10" is a thing a warehouse picks, weighs and ships as one item. It
 * has its own SKU, its own barcode and its own price. How many of those packs
 * a buyer wants is a number they type on the product page, and it is stored on
 * the cart line, never on the variant. A buyer choosing a 500 g packet, Pack
 * of 10, and a quantity of 2 is buying 2 packs = 20 packets = 10 kg. A system
 * that folded the 2 into the variant would have invented a "Pack of 20" nobody
 * stocks.
 *
 * Everything here is integer arithmetic. Measurements are decimal strings
 * parsed to scaled integers, never JavaScript numbers, for the same reason
 * money is: 0.1 + 0.2 is not 0.3, and a total net weight that is wrong in the
 * seventh decimal place prints as wrong on a delivery note.
 */
import { ErrorCode, badRequest } from '../errors.js';

/** Decimal places kept internally for a measurement. */
const MEASURE_SCALE = 6n;
const MEASURE_FACTOR = 10n ** MEASURE_SCALE;

/**
 * Units that convert within one family, expressed against a base.
 *
 * Only families where the conversion is exact and universally agreed. Anything
 * else - a "reel", a "bag", a "sheet" - is a unit that means whatever the
 * seller says it means, and converting it would be inventing a fact.
 */
const UNIT_FACTORS: Readonly<Record<string, { family: string; perBase: bigint }>> = Object.freeze({
  mg: { family: 'mass', perBase: 1n },
  g: { family: 'mass', perBase: 1000n },
  kg: { family: 'mass', perBase: 1000000n },
  ml: { family: 'volume', perBase: 1n },
  cl: { family: 'volume', perBase: 10n },
  l: { family: 'volume', perBase: 1000n },
  mm: { family: 'length', perBase: 1n },
  cm: { family: 'length', perBase: 10n },
  m: { family: 'length', perBase: 1000n },
  km: { family: 'length', perBase: 1000000n },
  pieces: { family: 'count', perBase: 1n },
  piece: { family: 'count', perBase: 1n },
  sheets: { family: 'count', perBase: 1n },
});

/** A quantity the seller stated: a decimal string and the unit they chose. */
export interface Measurement {
  /** Decimal as typed. Never a float - "0.75", "25", "1.5". */
  readonly value: string;
  readonly unit: string;
}

/** Parse a decimal string to a scaled integer. Throws on anything else. */
export function parseMeasure(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a positive number with up to six decimal places.', [
      { field, code: 'INVALID_MEASUREMENT', meta: { value } },
    ]);
  }

  const [whole = '0', fraction = ''] = trimmed.split('.');
  return BigInt(whole) * MEASURE_FACTOR + BigInt(fraction.padEnd(Number(MEASURE_SCALE), '0'));
}

/** Print a scaled integer back as a decimal string, trailing zeros removed. */
export function formatMeasure(scaled: bigint): string {
  const whole = scaled / MEASURE_FACTOR;
  const fraction = (scaled % MEASURE_FACTOR).toString().padStart(Number(MEASURE_SCALE), '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole.toString() : `${whole}.${trimmed}`;
}

function unitKey(unit: string): string {
  return unit.trim().toLowerCase();
}

/** Whether two units can be compared at all. */
export function isConvertible(from: string, to: string): boolean {
  const a = UNIT_FACTORS[unitKey(from)];
  const b = UNIT_FACTORS[unitKey(to)];
  return a !== undefined && b !== undefined && a.family === b.family;
}

/**
 * Convert a measurement between units of one family.
 *
 * Returns null rather than guessing when the units are not convertible. A
 * "per kg" price on something sold in metres is not a rounding problem, it is
 * a question with no answer, and the page shows nothing rather than a number.
 */
export function convertMeasure(scaled: bigint, from: string, to: string): bigint | null {
  const a = UNIT_FACTORS[unitKey(from)];
  const b = UNIT_FACTORS[unitKey(to)];
  if (a === undefined || b === undefined || a.family !== b.family) return null;
  return (scaled * a.perBase) / b.perBase;
}

// ---------------------------------------------------------------------------
// PACKS
// ---------------------------------------------------------------------------

/** How one sellable unit is made up. Every field optional; most products have none. */
export interface PackConfiguration {
  /**
   * How many identical sellable units are grouped into this one - the 10 in
   * "Pack of 10". 1, or absent, for a single.
   */
  readonly multipackCount?: number | null;
  /** What is inside ONE of those units - 500 g, 250 ml, 100 sheets. */
  readonly netContent?: Measurement | null;
  /**
   * The manufacturer's own packaged unit, where that is a different thing -
   * "Box of 100" gloves inside a "Pack of 5" boxes.
   */
  readonly manufacturerPackLabel?: string | null;
}

export interface PackSummary {
  readonly multipackCount: number;
  readonly netContent: Measurement | null;
  /** Everything in one purchasable unit: net content x multipack count. */
  readonly totalContent: Measurement | null;
  readonly manufacturerPackLabel: string | null;
}

/**
 * What one purchasable unit actually contains.
 *
 * The figure a buyer needs and the one a catalogue most often fails to state:
 * 500 g x 10 is 5 kg, and "500 g, Pack of 10" without that sentence is two
 * numbers the reader has to multiply themselves.
 *
 * Presented in the unit the seller typed, not converted to a tidier one. The
 * seller wrote grams; 5000 g is what their paperwork says, and turning it into
 * 5 kg is a helpfulness that makes two documents disagree. The display layer
 * may offer the conversion beside it.
 */
export function summarisePack(configuration: PackConfiguration): PackSummary {
  const multipackCount =
    configuration.multipackCount === null || configuration.multipackCount === undefined
      ? 1
      : configuration.multipackCount;

  const netContent = configuration.netContent ?? null;

  const totalContent =
    netContent === null
      ? null
      : {
          value: formatMeasure(
            parseMeasure(netContent.value, 'netContent') * BigInt(Math.max(multipackCount, 1)),
          ),
          unit: netContent.unit,
        };

  return {
    multipackCount: Math.max(multipackCount, 1),
    netContent,
    totalContent,
    manufacturerPackLabel: configuration.manufacturerPackLabel ?? null,
  };
}

/**
 * Total content across a whole cart line.
 *
 * Quantity 2 of "500 g, Pack of 10" is 10 kg, and this is the only place that
 * arithmetic is done. Shown on the product page before Add to Cart, because a
 * buyer who discovers it on the delivery note has been surprised by ten
 * kilograms.
 */
export function lineContent(summary: PackSummary, cartQuantity: number): Measurement | null {
  if (summary.totalContent === null) return null;
  if (!Number.isInteger(cartQuantity) || cartQuantity < 1) return null;

  return {
    value: formatMeasure(
      parseMeasure(summary.totalContent.value, 'totalContent') * BigInt(cartQuantity),
    ),
    unit: summary.totalContent.unit,
  };
}

// ---------------------------------------------------------------------------
// UNIT PRICING
// ---------------------------------------------------------------------------

export interface UnitPrice {
  /** Minor units, per `baseMeasure`. Rounded half-up. */
  readonly amountMinor: bigint;
  readonly baseMeasure: Measurement;
}

/**
 * What one standard amount costs - "12.40 per kg", "0.31 per 100 g".
 *
 * Computed from the TOTAL content of the purchasable unit, so "500 g, Pack of
 * 10" at 620.00 is 124.00 per kg and not 1,240.00. The base measure is the
 * seller's, or a sensible one for the family, and is stated beside the figure
 * rather than assumed: "per 100 g" and "per kg" are a factor of ten apart and
 * a shopper comparing two listings has to be able to see which is which.
 *
 * Null whenever the answer would have to be invented - no content stated, a
 * base in a unit that does not convert, or a content of zero.
 */
export function unitPrice(
  priceMinor: bigint,
  summary: PackSummary,
  baseMeasure: Measurement,
): UnitPrice | null {
  if (summary.totalContent === null) return null;

  const total = parseMeasure(summary.totalContent.value, 'totalContent');
  if (total <= 0n) return null;

  const base = parseMeasure(baseMeasure.value, 'baseMeasure');
  if (base <= 0n) return null;

  const totalInBaseUnit = convertMeasure(total, summary.totalContent.unit, baseMeasure.unit);
  if (totalInBaseUnit === null || totalInBaseUnit <= 0n) return null;

  // price * base / totalInBaseUnit, rounded half-up on the final division so
  // the printed figure is the nearest minor unit rather than truncated.
  const numerator = priceMinor * base * 2n + totalInBaseUnit;
  const amountMinor = numerator / (totalInBaseUnit * 2n);

  return { amountMinor, baseMeasure };
}

/**
 * The base amount to quote against, when the seller has not chosen one.
 *
 * Deliberately conservative: a kilogram for mass, a litre for volume, a metre
 * for length, one piece for a count. A shop selling 5 g sachets would be
 * better served by "per 100 g", and the seller can say so - this is the
 * fallback, not a recommendation.
 */
export function defaultBaseMeasure(unit: string): Measurement | null {
  const entry = UNIT_FACTORS[unitKey(unit)];
  if (entry === undefined) return null;

  switch (entry.family) {
    case 'mass':
      return { value: '1', unit: 'kg' };
    case 'volume':
      return { value: '1', unit: 'L' };
    case 'length':
      return { value: '1', unit: 'm' };
    case 'count':
      return { value: '1', unit: 'piece' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PURCHASING RULES
// ---------------------------------------------------------------------------

/** A variant's own terms of trade. Falls back to the product family's. */
export interface PurchaseRules {
  readonly minOrderQty: number;
  readonly qtyIncrement: number;
  readonly maxOrderQty: number | null;
}

export type QuantityProblem =
  | 'BELOW_MINIMUM'
  | 'NOT_A_MULTIPLE'
  | 'ABOVE_MAXIMUM'
  | 'ABOVE_AVAILABLE'
  | 'NOT_A_WHOLE_NUMBER';

export interface QuantityVerdict {
  readonly isValid: boolean;
  readonly problem: QuantityProblem | null;
  /** The nearest quantity that would be accepted. Never below the minimum. */
  readonly suggested: number;
}

/**
 * Whether a quantity may be bought, and what to offer instead.
 *
 * Runs in the browser so the buyer is told before they click, and again on the
 * server because the browser is not a source of truth. A client that could
 * choose its own minimum could buy one of something sold in tens.
 *
 * `available` is the published figure or null. Null does not permit anything -
 * the reservation at Add to Cart is what actually settles stock - it only
 * means this check has nothing to say about it.
 */
export function validateQuantity(
  quantity: number,
  rules: PurchaseRules,
  available: number | null,
): QuantityVerdict {
  const minimum = Math.max(rules.minOrderQty, 1);
  const step = Math.max(rules.qtyIncrement, 1);

  if (!Number.isInteger(quantity)) {
    return { isValid: false, problem: 'NOT_A_WHOLE_NUMBER', suggested: minimum };
  }

  if (quantity < minimum) {
    return { isValid: false, problem: 'BELOW_MINIMUM', suggested: minimum };
  }

  // Steps are counted FROM the minimum, not from zero. A minimum of 10 with a
  // step of 3 permits 10, 13, 16 - not 12, which is a multiple of nothing the
  // seller offered.
  const stepsAbove = (quantity - minimum) % step;
  if (stepsAbove !== 0) {
    return {
      isValid: false,
      problem: 'NOT_A_MULTIPLE',
      suggested: quantity - stepsAbove + step,
    };
  }

  if (rules.maxOrderQty !== null && quantity > rules.maxOrderQty) {
    // Down to the highest permitted step at or below the maximum.
    const span = rules.maxOrderQty - minimum;
    const suggested = span < 0 ? minimum : minimum + Math.floor(span / step) * step;
    return { isValid: false, problem: 'ABOVE_MAXIMUM', suggested };
  }

  if (available !== null && quantity > available) {
    const span = available - minimum;
    const suggested = span < 0 ? minimum : minimum + Math.floor(span / step) * step;
    return { isValid: false, problem: 'ABOVE_AVAILABLE', suggested };
  }

  return { isValid: true, problem: null, suggested: quantity };
}

/** Bring a quantity onto the nearest permitted step, for a stepper control. */
export function clampQuantity(quantity: number, rules: PurchaseRules): number {
  const minimum = Math.max(rules.minOrderQty, 1);
  const step = Math.max(rules.qtyIncrement, 1);

  if (!Number.isFinite(quantity) || quantity <= minimum) return minimum;

  const steps = Math.round((quantity - minimum) / step);
  const candidate = minimum + steps * step;

  if (rules.maxOrderQty !== null && candidate > rules.maxOrderQty) {
    const span = rules.maxOrderQty - minimum;
    return span < 0 ? minimum : minimum + Math.floor(span / step) * step;
  }

  return candidate;
}
