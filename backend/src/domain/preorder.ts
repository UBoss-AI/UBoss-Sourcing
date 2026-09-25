/**
 * Bulk preorder rules.
 *
 * Pure: no I/O, no database, no clock except the one passed in. Everything a
 * preorder is judged on - which policy applies, what the minimum is in pieces,
 * the earliest date a delivery may be asked for, the indicative price - is
 * decided here, so the eligibility screen, the submission and the seller's
 * answer all reach the same verdict by calling the same function.
 *
 * Two rules the whole file follows:
 *
 *   - **Nothing is invented.** A policy with no minimum is incomplete, not a
 *     policy with a minimum of one. A package unit the offer has no active
 *     packaging for has no size, not a guessed one. A seller with no published
 *     transit time to a country contributes nothing to the lead time, and the
 *     result says so rather than assuming a number.
 *
 *   - **Quantities are pieces.** A buyer asks for ten pallets; this file works
 *     in the 12,000 pieces that is, because that is what capacity, price bands
 *     and the eventual order line are all counted in.
 */
import { createHash } from 'node:crypto';

import {
  addCalendarDays,
  isCalendarDay,
  laterOf,
  todayIn,
  type CalendarDay,
} from './delivery-dates.js';

export type PreorderUnit =
  | 'PIECE'
  | 'CARTON'
  | 'UK_PALLET'
  | 'US_PALLET'
  | 'CONTAINER'
  | 'CONTAINER_20_FT'
  | 'CONTAINER_40_FT';

export const PREORDER_UNITS: readonly PreorderUnit[] = Object.freeze([
  'PIECE',
  'CONTAINER_20_FT',
  'CONTAINER_40_FT',
  'CARTON',
  'UK_PALLET',
  'US_PALLET',
  'CONTAINER',
]);

/** The units a seller may set a policy's minimum in. Containers are not among them. */
export const POLICY_MOQ_UNITS = ['PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'] as const;

/**
 * Where a request's terms came from. `PLATFORM_DEFAULT` is never a stored
 * policy row: it is the terms every product gets when nobody configured any
 * (`PREORDER_OPEN_TO_ALL`), frozen onto the request like any other.
 */
export type PreorderScope = 'OFFER' | 'PRODUCT' | 'SELLER_DEFAULT' | 'PLATFORM_DEFAULT';

export type CapacityPeriod = 'DAY' | 'WEEK' | 'MONTH';

export type PricingMode = 'FIXED' | 'QUOTE_REQUIRED';

/** The platform's own defaults. Never a minimum quantity - see the header. */
export interface PlatformPreorderDefaults {
  /** The notice period every scheduled delivery keeps: today + N days. */
  minNoticeDays: number;
  requestExpiryHours: number;
  offerExpiryHours: number;
  paymentExpiryHours: number;
}

export interface PolicyTier {
  minBaseUnits: number;
  unitPriceMinor: bigint;
  currency: string;
}

/** A policy as the rules read it. */
export interface PolicyTerms {
  id: string;
  scope: PreorderScope;
  version: number;
  isEnabled: boolean;
  moqUnit: PreorderUnit;
  moqQuantity: number | null;
  incrementQuantity: number;
  maxQuantity: number | null;
  capacityBaseUnits: number | null;
  capacityPeriod: CapacityPeriod;
  /** Stock kept back from preorders, in pieces. Zero means none. */
  safetyStockBaseUnits: number;
  minLeadTimeDays: number | null;
  maxAdvanceDays: number | null;
  deliveryCountries: string[];
  eligibleLocationIds: string[];
  /** Null means PIECE plus every packaging the offer has active. */
  packagingTypes: PreorderUnit[] | null;
  pricingMode: PricingMode;
  allowPartialFulfilment: boolean;
  allowSplitDelivery: boolean;
  requestExpiryHours: number | null;
  offerExpiryHours: number | null;
  cancellationTerms: string | null;
  specialInstructions: string | null;
  tiers: PolicyTier[];
}

// ---------------------------------------------------------------------------
// Which policy applies
// ---------------------------------------------------------------------------

const SCOPE_ORDER: readonly PreorderScope[] = ['OFFER', 'PRODUCT', 'SELLER_DEFAULT'];

/**
 * The policy that governs an offer: the most specific one that exists.
 *
 * Whole-record, never field-by-field. Merging a variant's MOQ with a
 * product's capacity and a seller default's price bands would produce terms
 * nobody wrote down, and the seller could not answer "where did that figure
 * come from?" by looking at any one screen.
 */
export function resolvePolicy<T extends { scope: PreorderScope }>(
  policies: readonly T[],
): T | null {
  for (const scope of SCOPE_ORDER) {
    const match = policies.find((policy) => policy.scope === scope);
    if (match !== undefined) return match;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Pieces in one of each unit, for one offer.
 *
 * PIECE is always 1. A package unit is present only where the offer has an
 * ACTIVE packaging option for it - the caller builds this from
 * `listBuyableOptions`, so an incomplete pallet is simply absent.
 */
export type UnitSizes = Partial<Record<PreorderUnit, number>>;

export function baseUnitsFor(
  quantity: number,
  unit: PreorderUnit,
  sizes: UnitSizes,
): number | null {
  const size = unit === 'PIECE' ? 1 : sizes[unit];
  if (size === undefined || size <= 0) return null;
  const total = quantity * size;
  return Number.isSafeInteger(total) ? total : null;
}

/** The units a buyer may order this in, under this policy. */
export function orderableUnits(policy: PolicyTerms, sizes: UnitSizes): PreorderUnit[] {
  const available = PREORDER_UNITS.filter((unit) => unit === 'PIECE' || (sizes[unit] ?? 0) > 0);
  if (policy.packagingTypes === null || policy.packagingTypes.length === 0) return available;
  return available.filter((unit) => policy.packagingTypes?.includes(unit) ?? false);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type IneligibleReason =
  /** The product is sold by the operator, not a seller. */
  | 'NOT_MARKETPLACE'
  /** No policy anywhere in the chain. */
  | 'NOT_CONFIGURED'
  /** The policy that applies says no. */
  | 'DISABLED'
  /** The policy exists and is missing something a preorder needs. */
  | 'INCOMPLETE'
  | 'OFFER_INACTIVE'
  | 'VARIANT_INACTIVE'
  | 'SELLER_SUSPENDED';

/** What a buyer may ask for, in pieces, once a policy is known to apply. */
export interface QuantityRules {
  minimumBaseUnits: number;
  incrementBaseUnits: number;
  maximumBaseUnits: number | null;
}

export interface PolicyIssue {
  field: string;
  message: string;
}

/**
 * The quantity rules in pieces, or the reason there are none.
 *
 * MOQ, increment and maximum are all converted through the SAME unit - the
 * policy's `moqUnit` - so "minimum 10 pallets, in steps of 2" becomes
 * "12,000 pieces in steps of 2,400" and cannot become a minimum counted in
 * pallets with a step counted in pieces.
 */
export function quantityRulesFor(
  policy: PolicyTerms,
  sizes: UnitSizes,
): { rules: QuantityRules; issues: [] } | { rules: null; issues: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];

  if (policy.moqQuantity === null || policy.moqQuantity <= 0) {
    issues.push({ field: 'moqQuantity', message: 'No minimum preorder quantity has been set.' });
  }

  const unitSize = policy.moqUnit === 'PIECE' ? 1 : sizes[policy.moqUnit];
  if (unitSize === undefined || unitSize <= 0) {
    issues.push({
      field: 'moqUnit',
      message: `The minimum is set in ${policy.moqUnit.toLowerCase().replace('_', ' ')}s, and this product has no active packaging of that kind.`,
    });
  }

  if (policy.pricingMode === 'FIXED' && policy.tiers.length === 0) {
    issues.push({
      field: 'tiers',
      message: 'Fixed preorder pricing is selected and no price band has been set.',
    });
  }

  if (issues.length > 0 || unitSize === undefined || policy.moqQuantity === null) {
    return { rules: null, issues };
  }

  const minimum = policy.moqQuantity * unitSize;
  const increment = Math.max(1, policy.incrementQuantity) * unitSize;
  const maximum = policy.maxQuantity === null ? null : policy.maxQuantity * unitSize;

  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(increment)) {
    return {
      rules: null,
      issues: [{ field: 'moqQuantity', message: 'The minimum is too large to count.' }],
    };
  }

  if (maximum !== null && maximum < minimum) {
    return {
      rules: null,
      issues: [{ field: 'maxQuantity', message: 'The maximum is below the minimum.' }],
    };
  }

  return {
    rules: { minimumBaseUnits: minimum, incrementBaseUnits: increment, maximumBaseUnits: maximum },
    issues: [],
  };
}

export type QuantityViolation =
  | { code: 'BELOW_MINIMUM'; minimumBaseUnits: number }
  | { code: 'INCREMENT'; incrementBaseUnits: number; minimumBaseUnits: number }
  | { code: 'ABOVE_MAXIMUM'; maximumBaseUnits: number };

/**
 * Is this many pieces something the seller takes a preorder for?
 *
 * The increment is counted FROM THE MINIMUM, not from zero. "Minimum 1,000,
 * in steps of 250" accepts 1,000, 1,250 and 1,500 - and a minimum that is not
 * itself a multiple of the step (1,000 in steps of 300) still accepts 1,000
 * and 1,300, which is what a seller who wrote those two numbers meant.
 */
export function checkPreorderQuantity(
  baseUnits: number,
  rules: QuantityRules,
): QuantityViolation | null {
  if (baseUnits < rules.minimumBaseUnits) {
    return { code: 'BELOW_MINIMUM', minimumBaseUnits: rules.minimumBaseUnits };
  }
  if ((baseUnits - rules.minimumBaseUnits) % rules.incrementBaseUnits !== 0) {
    return {
      code: 'INCREMENT',
      incrementBaseUnits: rules.incrementBaseUnits,
      minimumBaseUnits: rules.minimumBaseUnits,
    };
  }
  if (rules.maximumBaseUnits !== null && baseUnits > rules.maximumBaseUnits) {
    return { code: 'ABOVE_MAXIMUM', maximumBaseUnits: rules.maximumBaseUnits };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export interface DeliveryWindowInput {
  timezone: string;
  /** Platform notice, calendar days. Never less than 1: today is never allowed. */
  minNoticeDays: number;
  /** The seller's production lead time, calendar days. */
  productionLeadDays: number | null;
  /** Handling plus the published transit to the destination, calendar days. */
  routeLeadDays: number;
  maxAdvanceDays: number | null;
  now?: Date;
}

export interface DeliveryWindow {
  today: CalendarDay;
  earliest: CalendarDay;
  /** Null when the seller set no advance-booking limit. */
  latest: CalendarDay | null;
  /** Which of the three floors decided `earliest`, for the explanation. */
  decidedBy: 'NOTICE' | 'PRODUCTION' | 'ROUTE';
}

/**
 * The earliest and latest day a preorder delivery may be asked for.
 *
 *   earliest = max( today + platform notice,
 *                   today + seller production lead time,
 *                   today + route lead time )
 *
 * Counted on the buyer's own wall clock, in calendar days - the same rule, and
 * the same functions, as the Schedule Cart's seven-day notice, so a preorder
 * can never be booked sooner than an ordinary scheduled delivery could.
 */
export function preorderDeliveryWindow(input: DeliveryWindowInput): DeliveryWindow {
  const today = todayIn(input.timezone, input.now ?? new Date());

  const notice = addCalendarDays(today, Math.max(1, Math.trunc(input.minNoticeDays)));
  const production = addCalendarDays(today, Math.max(0, Math.trunc(input.productionLeadDays ?? 0)));
  const route = addCalendarDays(today, Math.max(0, Math.trunc(input.routeLeadDays)));

  const earliest = laterOf(laterOf(notice, production), route);

  const decidedBy =
    earliest === notice ? 'NOTICE' : earliest === production ? 'PRODUCTION' : 'ROUTE';

  const latest =
    input.maxAdvanceDays === null ? null : addCalendarDays(today, Math.trunc(input.maxAdvanceDays));

  return { today, earliest, latest, decidedBy };
}

export type DateViolation =
  | { code: 'INVALID' }
  | { code: 'TOO_EARLY'; earliest: CalendarDay }
  | { code: 'TOO_FAR'; latest: CalendarDay };

export function checkDeliveryDate(day: string, window: DeliveryWindow): DateViolation | null {
  if (!isCalendarDay(day)) return { code: 'INVALID' };
  if (day < window.earliest) return { code: 'TOO_EARLY', earliest: window.earliest };
  if (window.latest !== null && day > window.latest)
    return { code: 'TOO_FAR', latest: window.latest };
  return null;
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

export interface IndicativePrice {
  unitPriceMinor: bigint;
  goodsTotalMinor: bigint;
  /** The band that applied, or null when the offer's own price did. */
  tierMinBaseUnits: number | null;
  currency: string;
}

/**
 * What this many pieces would cost under FIXED pricing.
 *
 * The highest band the quantity reaches, or the offer's own list price where
 * it reaches none. Null under QUOTE_REQUIRED, or where a band is priced in a
 * currency other than the offer's - a band the offer cannot be charged in is
 * not a price.
 *
 * INDICATIVE. It is what the form shows; the seller confirms the price in
 * their answer, and the order is built from that answer.
 */
export function indicativePrice(input: {
  pricingMode: PricingMode;
  tiers: readonly PolicyTier[];
  baseUnits: number;
  offerUnitPriceMinor: bigint;
  offerCurrency: string;
}): IndicativePrice | null {
  if (input.pricingMode !== 'FIXED') return null;

  let applied: PolicyTier | null = null;
  for (const tier of input.tiers) {
    if (tier.currency !== input.offerCurrency) continue;
    if (input.baseUnits < tier.minBaseUnits) continue;
    if (applied === null || tier.minBaseUnits > applied.minBaseUnits) applied = tier;
  }

  // A preorder band dearer than the offer's own price for this quantity
  // (its list price, or its quantity band) is not applied: ordering more, and
  // waiting for it, never costs more per piece than the basket would.
  const band =
    applied !== null && applied.unitPriceMinor < input.offerUnitPriceMinor ? applied : null;
  const unitPriceMinor = band?.unitPriceMinor ?? input.offerUnitPriceMinor;
  if (unitPriceMinor <= 0n) return null;

  return {
    unitPriceMinor,
    goodsTotalMinor: unitPriceMinor * BigInt(input.baseUnits),
    tierMinBaseUnits: band?.minBaseUnits ?? null,
    currency: input.offerCurrency,
  };
}

// ---------------------------------------------------------------------------
// Capacity periods
// ---------------------------------------------------------------------------

/**
 * The capacity bucket a delivery day falls in.
 *
 * Capacity is counted against the period of the COMMITTED DELIVERY DATE. A
 * seller who can make 50,000 a month is promising 50,000 deliveries a month,
 * and the date both parties agreed is the one fact about a preorder that does
 * not move.
 *
 * Weeks are ISO-8601 (Monday start, week 1 contains the first Thursday), so
 * the last days of December can belong to week 1 of the next year.
 */
export function capacityPeriodKey(day: CalendarDay, period: CapacityPeriod): string {
  if (period === 'DAY') return day;
  if (period === 'MONTH') return day.slice(0, 7);

  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, date));
  // Thursday of this week decides which ISO year the week belongs to.
  const weekday = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - weekday + 3);
  const isoYear = utc.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((utc.getTime() - firstThursday.getTime()) / (7 * 86_400_000));

  return `${String(isoYear)}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface PreorderTerms {
  requestId: string;
  revision: number;
  quantityBaseUnits: number;
  unitPriceMinor: bigint;
  goodsTotalMinor: bigint;
  freightMinor: bigint;
  currency: string;
  committedDeliveryDate: CalendarDay;
  deliverySplits: { date: CalendarDay; baseUnits: number }[] | null;
  /**
   * A revised-date or split-delivery answer: its kind, the stock it takes and
   * its schedule. Absent on an ordinary acceptance or counter, and then left
   * out of the canonical form entirely - so every hash written before this
   * existed still matches its terms.
   */
  fulfilment?: {
    kind: 'FULL_ON_REVISED_DATE' | 'SPLIT_DELIVERY';
    stockAllocationBaseUnits: number;
    installments: {
      sequence: number;
      date: CalendarDay;
      baseUnits: number;
      source: 'AVAILABLE_STOCK' | 'FUTURE_SUPPLY';
    }[];
  };
}

/**
 * The canonical form of a set of terms, and its SHA-256.
 *
 * Key order is fixed and money is a decimal string, so the same terms hash to
 * the same value whichever process computed them. The buyer's confirmation
 * carries this hash; a confirmation of anything else is refused.
 */
export function canonicalTerms(terms: PreorderTerms): string {
  return JSON.stringify({
    requestId: terms.requestId,
    revision: terms.revision,
    quantityBaseUnits: terms.quantityBaseUnits,
    unitPriceMinor: terms.unitPriceMinor.toString(),
    goodsTotalMinor: terms.goodsTotalMinor.toString(),
    freightMinor: terms.freightMinor.toString(),
    currency: terms.currency,
    committedDeliveryDate: terms.committedDeliveryDate,
    deliverySplits:
      terms.deliverySplits === null
        ? null
        : terms.deliverySplits.map((split) => ({ date: split.date, baseUnits: split.baseUnits })),
    ...(terms.fulfilment === undefined
      ? {}
      : {
          fulfilment: {
            kind: terms.fulfilment.kind,
            stockAllocationBaseUnits: terms.fulfilment.stockAllocationBaseUnits,
            installments: terms.fulfilment.installments.map((part) => ({
              sequence: part.sequence,
              date: part.date,
              baseUnits: part.baseUnits,
              source: part.source,
            })),
          },
        }),
  });
}

export function termsHash(terms: PreorderTerms): string {
  return createHash('sha256').update(canonicalTerms(terms)).digest('hex');
}

/**
 * Split deliveries must add up to the whole, fall on real days no earlier than
 * `earliest`, and be in date order. The committed date is the LAST split, so
 * "delivered by" means what it says.
 */
export function checkDeliverySplits(
  splits: readonly { date: string; baseUnits: number }[],
  totalBaseUnits: number,
  committedDate: CalendarDay,
): string | null {
  if (splits.length < 2) return 'A split delivery needs at least two parts.';

  let sum = 0;
  let previous = '';
  for (const split of splits) {
    if (!isCalendarDay(split.date)) return `${split.date} is not a date.`;
    if (!Number.isSafeInteger(split.baseUnits) || split.baseUnits <= 0) {
      return 'Every part of a split delivery must have a quantity.';
    }
    if (split.date <= previous) return 'Split deliveries must be in date order, on different days.';
    previous = split.date;
    sum += split.baseUnits;
  }

  if (sum !== totalBaseUnits) {
    return `The parts add up to ${String(sum)} and the order is for ${String(totalBaseUnits)}.`;
  }
  if (previous !== committedDate) return 'The last delivery must be on the committed date.';
  return null;
}
