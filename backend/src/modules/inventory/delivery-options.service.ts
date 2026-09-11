/**
 * Which warehouses can deliver this basket to this country, and on what terms.
 *
 * The storefront half of geofencing. `delivery-coverage.service.ts` answers
 * the operator's question - "which countries does this warehouse reach" - and
 * this answers the buyer's, which is the same geometry read from the other
 * end: *my* country is fixed, and I want to know who can serve it, when, and
 * for how much.
 *
 * FOUR RULES, AND EACH OF THEM IS A REFUSAL THIS MODULE MAKES ON PURPOSE
 *
 *   - **Reach is not enough; the warehouse must also have the stock.** A
 *     warehouse 200 km away that does not hold the item cannot deliver it, and
 *     offering it would be a promise broken at the picking face rather than at
 *     checkout. So availability is checked per line, per warehouse, and a
 *     warehouse that can only fill part of the basket is reported separately -
 *     as `partial` - rather than mixed in with the ones that can fill it all.
 *     It is still reported, because "Antwerp has three of the four things you
 *     want" is useful to a buyer who can split an order and useless if it is
 *     hidden.
 *   - **An excluded country is not offered, and this is where that bites.**
 *     The coverage map keeps a closed country visible so an operator can see
 *     the decision they made; a buyer must simply not be offered it. Both
 *     behaviours come from the same rows, and the difference is the audience.
 *   - **A warehouse that cannot ship today is not offered either.** MAINTENANCE
 *     and SUSPENDED mean no boxes are leaving the building. LIMITED does mean
 *     boxes are leaving, so it is offered, and the option says so - a buyer
 *     choosing between two warehouses is entitled to know one of them is short
 *     staffed.
 *   - **Nothing is invented.** A warehouse with no lead time recorded and no
 *     fee priced is not offered with a made-up "3-5 days, free": it is
 *     reported with nulls, and the storefront says the terms have not been
 *     published. A delivery promise this software made up is a promise nobody
 *     agreed to.
 *
 * **The measurement is the same measurement.** Distance comes from
 * `distanceToCountryKm`, which walks the same Natural Earth polygons and the
 * same nearest-border rule the admin panel's ring is drawn from. Two
 * implementations of "does Antwerp reach Belgium" is how a buyer is offered a
 * warehouse the operator's own map says is out of range.
 *
 * **Ordering is a presentation, not a decision.** The options come back
 * fastest first, and the fastest and cheapest are flagged - but nothing here
 * picks one. Which of "two days for €12" and "five days for nothing" is
 * better is the buyer's call, and a default selection made by this software
 * would be this software spending their money.
 */
import { serialiseMoney } from '../../domain/money.js';
import { isoCountries } from '../../domain/country-boundaries.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import { distanceToCountryKm } from './delivery-coverage.service.js';
import { classifyCoordinates } from './location.service.js';
import type { OperationalStatus } from './location.service.js';

/** One thing the buyer wants, as the caller names it. */
export interface DeliveryOptionItem {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

/** One line of the basket, judged against one warehouse. */
export interface DeliveryOptionLine {
  productId: string;
  variantId: string | null;
  /** The product's name, so the storefront can say which line is short. */
  productName: string;
  /** The variant's SKU where there is one, else the product's. */
  sku: string;
  quantity: number;
  /**
   * On hand minus reserved at this warehouse.
   *
   * Reserved is subtracted because it is already promised to somebody else's
   * live checkout. A figure that ignored it would offer the same unit to two
   * buyers and let the second one find out at payment.
   */
  availableQty: number;
  /** False for a product that carries no quantity - made to order. */
  isStockTracked: boolean;
  /** Whether this warehouse can cover this line in full. */
  isFulfillable: boolean;
}

export interface DeliveryOption {
  warehouse: {
    id: string;
    code: string;
    name: string;
    /** ISO 3166-1 alpha-2 of the warehouse's own country. */
    countryCode: string | null;
    countryName: string | null;
    /** The town it dispatches from, for a buyer reading "ships from". */
    city: string | null;
    /** Can it ship today? LIMITED is offered and said out loud. */
    operationalStatus: OperationalStatus;
  };
  /**
   * Kilometres from the warehouse to the destination country's nearest border.
   *
   * Zero for a warehouse standing inside the destination country. Not a
   * distance to the buyer's own address - this module never sees one, and
   * should not: a delivery option is offered before an address is chosen, and
   * a promise that changed once a postcode was typed would be a different
   * promise.
   */
  distanceKm: number;
  /** The geofence this option passed - the warehouse's own, or the default. */
  radiusKm: number;
  /** Null where this warehouse has not published a lead time. */
  leadTimeDays: { min: number; max: number } | null;
  /** Null where it has not priced delivery. */
  fee: { minor: string; formatted: string; currency: string } | null;
  /** True when every line can be covered from this warehouse alone. */
  canFulfilAll: boolean;
  /** How many of the requested lines it can cover. */
  fulfillableLines: number;
  lines: DeliveryOptionLine[];
  /**
   * The fastest and the cheapest of the options that can fill the basket.
   *
   * Both can be the same option, and both are false on every option when no
   * warehouse published terms to compare. Flags rather than an order, because
   * "cheapest" is not a position in a list once two options tie.
   */
  isFastest: boolean;
  isCheapest: boolean;
}

export interface DeliveryOptionsResult {
  destination: { countryCode: string; countryName: string };
  /** Warehouses that can deliver the whole basket. Fastest first. */
  options: DeliveryOption[];
  /**
   * Warehouses in range that can deliver only part of it.
   *
   * Kept separate from `options` rather than filtered out: a buyer who can
   * split an order wants to see them, and a buyer who cannot needs to know why
   * a warehouse they expected is not on the list. The storefront shows them
   * under their own heading.
   */
  partial: DeliveryOption[];
  /**
   * How many warehouses whose geofence reaches this country were withheld
   * because the operator closed it.
   *
   * A count and not a list. The buyer has no business reading an operator's
   * internal reason for not shipping to Luxembourg, and a screen that said
   * "we could serve you from Antwerp but choose not to" would be worse than
   * silence. The count exists so the storefront can distinguish "nobody is
   * near enough" from "nobody serves your country", which are different
   * sentences and different next steps.
   */
  closedByOperator: number;
  computedAt: string;
}

export interface DeliveryOptionsInput {
  /** ISO 3166-1 alpha-2 of where the buyer wants it delivered. */
  countryCode: string;
  /**
   * The basket. May be empty.
   *
   * Empty is a real and useful question - "who could ever deliver to Belgium"
   * - which is what a product page or a country picker asks before anything is
   * in a cart. Every warehouse in range then comes back able to fill a basket
   * of nothing, which is true, and `lines` is empty.
   */
  items?: readonly DeliveryOptionItem[];
}

/** Sort key for the option list: soonest arrival, then cheapest, then nearest. */
function byPromise(a: DeliveryOption, b: DeliveryOption): number {
  // A warehouse with no published lead time sorts after every one that has
  // published one. It is not slow - it is silent - and putting silence at the
  // top of a list of delivery promises would be the wrong way round.
  const aDays = a.leadTimeDays?.max ?? Number.POSITIVE_INFINITY;
  const bDays = b.leadTimeDays?.max ?? Number.POSITIVE_INFINITY;
  if (aDays !== bDays) return aDays - bDays;

  // Same reasoning for an unpriced fee, and note this is only a *sort*: the
  // two amounts may be in different currencies, which is exactly why nothing
  // here adds them or claims one is cheaper. `isCheapest` below refuses to
  // compare across currencies at all.
  const aFee = a.fee === null ? Number.POSITIVE_INFINITY : Number(a.fee.minor);
  const bFee = b.fee === null ? Number.POSITIVE_INFINITY : Number(b.fee.minor);
  if (aFee !== bFee) return aFee - bFee;

  return a.distanceKm - b.distanceKm;
}

/**
 * Which of these options is the cheapest, when that can be said at all.
 *
 * Returns null when two options quote in different currencies. Comparing 1200
 * INR against 1200 EUR by their minor units would flag the wrong one, and
 * converting them here would need a rate, at which point the flag is an
 * exchange-rate opinion dressed up as a fact. A storefront that cannot be
 * told which is cheapest shows both prices and lets the buyer read them.
 */
function cheapestId(options: readonly DeliveryOption[]): string | null {
  const priced = options.filter(
    (option): option is DeliveryOption & { fee: NonNullable<DeliveryOption['fee']> } =>
      option.fee !== null,
  );

  if (priced.length === 0) return null;

  const currencies = new Set(priced.map((option) => option.fee.currency));
  if (currencies.size > 1) return null;

  let best = priced[0];
  if (best === undefined) return null;

  for (const option of priced) {
    if (BigInt(option.fee.minor) < BigInt(best.fee.minor)) best = option;
  }

  return best.warehouse.id;
}

/** The soonest arrival, or null when nobody published one. */
function fastestId(options: readonly DeliveryOption[]): string | null {
  let best: DeliveryOption | null = null;

  for (const option of options) {
    // A warehouse that has published no lead time is not the fastest. It is
    // silent, and silence is not speed.
    if (option.leadTimeDays === null) continue;

    const bestDays = best?.leadTimeDays ?? null;

    if (bestDays === null || option.leadTimeDays.max < bestDays.max) best = option;
  }

  return best?.warehouse.id ?? null;
}

/**
 * Who can deliver this basket to this country.
 *
 * Throws `VALIDATION_FAILED` for a country code that is not an ISO one. It
 * does **not** throw when nobody can deliver: an empty `options` with an empty
 * `partial` is a real answer that the storefront has a screen for, and turning
 * it into an error would make "we do not ship there yet" indistinguishable
 * from a broken request.
 */
export async function deliveryOptions(
  input: DeliveryOptionsInput,
): Promise<DeliveryOptionsResult> {
  const countryCode = input.countryCode.trim().toUpperCase();

  const iso = isoCountries().find((country) => country.code === countryCode);

  if (iso === undefined) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `"${input.countryCode}" is not a country code. Use the two-letter ISO code, e.g. BE for Belgium.`,
      [{ field: 'countryCode', code: 'UNKNOWN_COUNTRY' }],
    );
  }

  const items = input.items ?? [];

  // The deployment's own name for the country wins over the ISO one, the same
  // precedence the coverage panel uses: an operator who has corrected a name
  // in `countries` should see it everywhere, including on the storefront.
  const named = await prisma.country.findUnique({
    where: { code: countryCode },
    select: { name: true },
  });

  const destination = { countryCode, countryName: named?.name ?? iso.name };

  /**
   * Every warehouse that could conceivably be offered.
   *
   * Filtered in the query on the three things SQL can decide - active, able to
   * ship today, and not having closed this country - so the geometry below
   * runs on the shortest possible list. A warehouse under MAINTENANCE is
   * excluded here rather than measured and dropped later, because measuring it
   * is the expensive part.
   */
  const warehouses = await prisma.inventoryLocation.findMany({
    where: {
      isActive: true,
      operationalStatus: { in: ['OPERATIONAL', 'LIMITED'] },
      exclusions: { none: { countryCode } },
    },
    select: {
      id: true,
      code: true,
      name: true,
      countryCode: true,
      addressJson: true,
      latitude: true,
      longitude: true,
      operationalStatus: true,
      deliveryRadiusKm: true,
      deliveryLeadTimeMinDays: true,
      deliveryLeadTimeMaxDays: true,
      deliveryFeeMinor: true,
      deliveryFeeCurrency: true,
      country: { select: { name: true } },
    },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });

  /**
   * How many were withheld because the operator closed this country.
   *
   * Counted with the same active-and-shipping filter as above, so it means
   * "warehouses that would otherwise have been candidates" rather than "rows
   * in the exclusion table". The geofence is not applied to it - a closed
   * country 3,000 km away was never going to be offered, and counting it would
   * inflate the number into meaninglessness - so this is deliberately an upper
   * bound on the ones in range, and the storefront only ever asks whether it
   * is zero.
   */
  const closedByOperator = await prisma.inventoryLocation.count({
    where: {
      isActive: true,
      operationalStatus: { in: ['OPERATIONAL', 'LIMITED'] },
      exclusions: { some: { countryCode } },
    },
  });

  // The warehouses whose circle actually reaches the destination, measured.
  const inRange: { row: (typeof warehouses)[number]; distanceKm: number; radiusKm: number }[] = [];

  for (const row of warehouses) {
    // A warehouse nobody has placed cannot be measured from. It is left out
    // silently on the storefront - a buyer cannot fix a missing coordinate,
    // and the admin panel already names every unplaced warehouse on its own
    // screen, which is where that problem belongs.
    const position = classifyCoordinates(row);
    if (position.latitude === null || position.longitude === null) continue;

    const radiusKm = row.deliveryRadiusKm ?? env.DELIVERY_COVERAGE_RADIUS_KM;
    const distanceKm = distanceToCountryKm(
      { latitude: position.latitude, longitude: position.longitude },
      countryCode,
    );

    if (distanceKm === null || distanceKm > radiusKm) continue;

    inRange.push({ row, distanceKm, radiusKm });
  }

  /**
   * The basket's products, once, with the availability at every candidate.
   *
   * Two queries for the whole answer rather than two per warehouse: the
   * products are the same products whichever building is being considered, and
   * the balances are one `IN` over the candidate ids.
   */
  const productIds = [...new Set(items.map((item) => item.productId))];

  const products =
    productIds.length === 0
      ? []
      : await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            name: true,
            sku: true,
            isStockTracked: true,
            variants: { select: { id: true, sku: true } },
          },
        });

  const productById = new Map(products.map((product) => [product.id, product]));

  const balances =
    productIds.length === 0 || inRange.length === 0
      ? []
      : await prisma.inventoryBalance.findMany({
          where: {
            locationId: { in: inRange.map((candidate) => candidate.row.id) },
            productId: { in: productIds },
          },
          select: {
            locationId: true,
            productId: true,
            variantKey: true,
            onHandQty: true,
            reservedQty: true,
          },
        });

  const availableByKey = new Map(
    balances.map((balance) => [
      `${balance.locationId}:${balance.productId}:${balance.variantKey}`,
      balance.onHandQty - balance.reservedQty,
    ]),
  );

  const built: DeliveryOption[] = inRange.map((candidate) => {
    const address = candidate.row.addressJson;
    const city =
      typeof address === 'object' && address !== null && !Array.isArray(address)
        ? typeof (address as Record<string, unknown>)['city'] === 'string'
          ? ((address as Record<string, unknown>)['city'] as string)
          : null
        : null;

    const lines: DeliveryOptionLine[] = items.map((item) => {
      const variantId = item.variantId ?? null;
      const product = productById.get(item.productId);
      const variant = product?.variants.find((entry) => entry.id === variantId);
      const availableQty =
        availableByKey.get(
          `${candidate.row.id}:${item.productId}:${variantKeyOf(variantId)}`,
        ) ?? 0;

      // A product nobody tracks the quantity of is fulfillable from anywhere
      // that is in range: there is no number to be short of. A product this
      // request named that is not in the catalogue is *not* silently
      // fulfillable - it is reported unfulfillable so the caller sees the
      // problem rather than being told a phantom line is fine.
      const isStockTracked = product?.isStockTracked ?? true;

      return {
        productId: item.productId,
        variantId,
        productName: product?.name ?? item.productId,
        sku: variant?.sku ?? product?.sku ?? item.productId,
        quantity: item.quantity,
        availableQty,
        isStockTracked,
        isFulfillable:
          product !== undefined && (!isStockTracked || availableQty >= item.quantity),
      };
    });

    const fulfillableLines = lines.filter((line) => line.isFulfillable).length;

    return {
      warehouse: {
        id: candidate.row.id,
        code: candidate.row.code,
        name: candidate.row.name,
        countryCode: candidate.row.countryCode,
        countryName: candidate.row.country?.name ?? null,
        city,
        operationalStatus: candidate.row.operationalStatus,
      },
      distanceKm: candidate.distanceKm,
      radiusKm: candidate.radiusKm,
      leadTimeDays:
        candidate.row.deliveryLeadTimeMinDays === null ||
        candidate.row.deliveryLeadTimeMaxDays === null
          ? null
          : {
              min: candidate.row.deliveryLeadTimeMinDays,
              max: candidate.row.deliveryLeadTimeMaxDays,
            },
      fee:
        candidate.row.deliveryFeeMinor === null || candidate.row.deliveryFeeCurrency === null
          ? null
          : serialiseMoney(candidate.row.deliveryFeeMinor, candidate.row.deliveryFeeCurrency),
      canFulfilAll: fulfillableLines === lines.length,
      fulfillableLines,
      lines,
      // Set below, once the whole set is known.
      isFastest: false,
      isCheapest: false,
    };
  });

  const options = built.filter((option) => option.canFulfilAll).sort(byPromise);
  const partial = built.filter((option) => !option.canFulfilAll).sort(byPromise);

  // The flags are computed over the options a buyer can actually take. The
  // cheapest of the ones that cannot fill the basket is not a useful fact.
  const fastest = fastestId(options);
  const cheapest = cheapestId(options);

  for (const option of options) {
    option.isFastest = option.warehouse.id === fastest;
    option.isCheapest = option.warehouse.id === cheapest;
  }

  return {
    destination,
    options,
    partial,
    closedByOperator,
    computedAt: new Date().toISOString(),
  };
}
