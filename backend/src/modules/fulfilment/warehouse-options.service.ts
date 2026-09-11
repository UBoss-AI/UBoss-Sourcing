/**
 * Which warehouse will send this order, when it will arrive, and what it costs.
 *
 * The checkout half of fulfilment. `inventory/delivery-options.service.ts`
 * answers a nearby question - "who could ever deliver to Belgium" - from the
 * geofence, before anybody has an account or an address, and it is deliberately
 * left alone. This one answers the question a buyer asks with their card in
 * their hand: *this* basket, *this* address, priced, dated, and bindable.
 *
 * WHY THE RADIUS DOES NOT DECIDE ANYTHING HERE
 *
 * A geofence is geometry. A 500 km circle around Antwerp reaches Luxembourg
 * whether or not anybody has appointed a carrier there, agreed a transit time,
 * or priced the lane - and a checkout that sold against geometry would be
 * quoting a delivery nobody has arranged. So eligibility comes from
 * `WarehouseDeliveryZone`: an operator says which countries and postcodes each
 * building serves, who carries it, how long it takes and what it costs, and a
 * warehouse with no lane to the destination is simply not offered.
 *
 * The distance is still measured and still reported, because a buyer choosing
 * between two warehouses wants to know one is 40 km away and the other 900.
 * It is information printed on a card. It is not a rule.
 *
 * SIX REFUSALS THIS MODULE MAKES ON PURPOSE
 *
 *   - **A warehouse that cannot fill the whole basket is not an option.** It
 *     is reported under `ineligible` with the lines it is short of and the
 *     quantities, so the buyer can see why the depot in their own city is
 *     missing, and it is never quietly mixed in with the ones that can. There
 *     is no split-shipment flow in this product; offering half a basket as if
 *     it were a whole one would be a promise broken at the picking face.
 *   - **Nothing is substituted and nothing is switched.** A line that has gone
 *     short makes its warehouse ineligible. It does not become a different
 *     product, and the buyer is not moved to another building without being
 *     asked.
 *   - **No price is invented.** A lane quoting in a currency this basket is
 *     not priced in is refused rather than converted: a rate this software
 *     chose would be an exchange-rate opinion printed as a price.
 *   - **No promise is invented.** Dates come from the lane's own handling and
 *     transit figures, counted on the warehouse's clock and optionally in
 *     working days. A warehouse with no lane has no dates, so it has no
 *     option.
 *   - **The goods get a veto.** A product restricted in the destination closes
 *     every warehouse, and a product needing the cold chain closes every lane
 *     that cannot hold temperature. Both are named in the answer.
 *   - **An estimate is never an offer.** A quote taken from a country alone -
 *     before the buyer has chosen an address - is marked `isEstimate` and
 *     `assertQuoteUsable` refuses it. An estimate is a conversation.
 *
 * ONE PRICING ENGINE, AND THIS IS NOT A SECOND ONE
 *
 * Every figure except the delivery fee comes from `resolveCart`, which is the
 * same function the cart page, the review screen and `submitCheckout` call.
 * The lane's fee is handed *into* that same run as `shippingOverride`, so
 * `priceLines` applies the free-above threshold, assembles the grand total
 * from its own line totals, and `assertTotalsConsistent` checks the result -
 * exactly as it does for a shipping method. Adding a delivery fee to a
 * finished total afterwards would be a second implementation of "what does
 * this basket cost", which is how a customer ends up disputing a figure nobody
 * can explain.
 *
 * WHY A QUOTE IS A ROW AND NOT A CALCULATION
 *
 * The offer the buyer is shown is written down - price, dates, carrier,
 * warehouse, and a digest of the basket it was priced for. Choosing one hands
 * back its id, and `assertQuoteUsable` re-reads that row at payment and checks
 * the world still supports it. The alternative - recomputing from ids the
 * browser sends back - means the review screen and the charge are two runs
 * against a catalogue and a stock ledger that moved in between, and whichever
 * way that drifts the customer is charged something nobody showed them.
 */
import { createHash } from 'node:crypto';

import { env } from '../../config/env.js';
import {
  addBusinessDays,
  addCalendarDays,
  fromDateColumn,
  resolveTimezone,
  todayIn,
  toDateColumn,
  type CalendarDay,
} from '../../domain/delivery-dates.js';
import { ErrorCode, badRequest, conflict, isAppError } from '../../domain/errors.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import { calculateShipping } from '../../domain/pricing.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { resolveCart, type ResolvedCart } from '../cart/cart.service.js';
import {
  distanceToCountryKm,
  greatCircleKm,
} from '../inventory/delivery-coverage.service.js';
import { classifyCoordinates, type OperationalStatus } from '../inventory/location.service.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One line of the basket, as the caller names it. */
export interface QuoteItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface WarehouseOptionsInput {
  customerProfileId: string;
  /**
   * The address this is going to.
   *
   * Present is the real case and the only one checkout accepts: with an
   * address there is a postcode to match lanes against and, where it has been
   * geocoded, a point to measure to.
   */
  deliveryAddressId?: string | null;
  /**
   * Where the buyer is, when that is all they have said yet.
   *
   * Used only when there is no address. The answer is then marked
   * `isEstimate` and the storefront labels it so - see the module header.
   */
  countryCode?: string | null;
  /**
   * The basket as the browser believes it to be.
   *
   * Checked against the live cart rather than priced from: the server's cart
   * is the only basket that exists, and a client that disagrees with it is a
   * client showing the customer something that is no longer true. A mismatch
   * is refused with FULFILMENT_QUOTE_STALE rather than silently answered for
   * the other basket.
   */
  items?: readonly QuoteItemInput[];
  /** The currency the browser is showing. Checked, never applied. */
  currency?: string | null;
  /** `YYYY-MM-DD`. Optional: "can you make the 24th?" */
  requestedDeliveryDate?: string | null;
  /** Injectable clock, for tests. */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface OptionWarehouse {
  id: string;
  code: string;
  name: string;
  /** ISO 3166-1 alpha-2 of the warehouse's own country, for a flag. */
  countryCode: string | null;
  countryName: string | null;
  /** The town it dispatches from, for "ships from". */
  city: string | null;
  /** LIMITED can still ship, and the card says so. */
  operationalStatus: OperationalStatus;
}

/** One basket line, judged against one warehouse. */
export interface OptionLine {
  productId: string;
  variantId: string | null;
  productName: string;
  sku: string;
  quantity: number;
  /** On hand there, minus what other live checkouts have already promised. */
  availableQty: number;
  /** False for a made-to-order product, which carries no quantity anywhere. */
  isStockTracked: boolean;
  isFulfillable: boolean;
}

export interface WarehouseOption {
  /** The id checkout takes back. One quote per option, each independently bindable. */
  quoteId: string;
  /** ISO-8601. After this the offer is refused rather than repriced. */
  expiresAt: string;

  warehouse: OptionWarehouse;
  /**
   * Kilometres to the destination - to the address itself where it has
   * coordinates, to the country's nearest border otherwise, and null where
   * neither could be measured. Information, never a rule.
   */
  distanceKm: number | null;

  /** Every line covered in full. An option is never offered otherwise. */
  lines: OptionLine[];

  carrier: { name: string; serviceLevel: string };
  /** Days between the order and the box leaving the building. */
  handlingDays: number;
  /** Whether the day counts above and below skip weekends. */
  usesBusinessDays: boolean;
  transitDays: { min: number; max: number };
  /** `YYYY-MM-DD`, on the warehouse's own clock. */
  dispatchDate: CalendarDay;
  deliveryFromDate: CalendarDay;
  deliveryToDate: CalendarDay;
  /**
   * Whether this lane can make the date the caller asked for. Null when they
   * asked for none.
   */
  meetsRequestedDate: boolean | null;

  currency: string;
  totals: {
    subtotal: ReturnType<typeof serialiseMoney>;
    discount: ReturnType<typeof serialiseMoney>;
    tax: ReturnType<typeof serialiseMoney>;
    shipping: ReturnType<typeof serialiseMoney>;
    grandTotal: ReturnType<typeof serialiseMoney>;
  };

  /** Soonest arrival. Ties broken by the cheaper total. */
  isFastest: boolean;
  /** Lowest total. Comparable because every option quotes the same currency. */
  isCheapest: boolean;
  /**
   * The one selected when the buyer has expressed no preference.
   *
   * Not a fourth opinion about which is best: it is a name for the default,
   * so a card that is already selected says why. The rule is the cheapest of
   * the options arriving no more than a day after the fastest - which is the
   * trade most people make by hand - and it frequently coincides with one of
   * the two badges above. Exactly one option carries it whenever there is one.
   */
  isRecommended: boolean;
}

/** Why a warehouse the buyer might have expected is not on the list. */
export interface IneligibleWarehouse {
  warehouse: OptionWarehouse;
  /**
   * Machine-readable, because the storefront says something different about
   * each. Never a free-text-only answer.
   */
  reason:
    | 'NO_DELIVERY_ZONE'
    | 'COUNTRY_CLOSED'
    | 'INSUFFICIENT_STOCK'
    | 'PRODUCT_RESTRICTED'
    | 'COLD_CHAIN_UNSUPPORTED'
    | 'OVER_WEIGHT'
    | 'CURRENCY_MISMATCH'
    | 'NOT_PLACED';
  message: string;
  /** The lines it is short of, named with quantities. Empty for other reasons. */
  shortLines: OptionLine[];
}

/** A line the destination itself refuses, whatever warehouse it leaves. */
export interface RestrictedLine {
  productId: string;
  variantId: string | null;
  productName: string;
  /** The operator's reason, where they gave one. */
  reason: string | null;
}

export interface WarehouseOptionsResult {
  destination: {
    countryCode: string;
    countryName: string;
    postalCode: string | null;
    addressId: string | null;
  };
  /**
   * True when this was priced from a country rather than an address.
   *
   * The storefront labels such an answer "Estimated" and asks again once an
   * address is chosen; checkout refuses it outright.
   */
  isEstimate: boolean;
  currency: string;
  /** Fastest first, then cheapest, then nearest. */
  options: WarehouseOption[];
  ineligible: IneligibleWarehouse[];
  /** Products this destination will not accept from anywhere. */
  restrictedLines: RestrictedLine[];
  /** The soonest any option can deliver, or null when there are none. */
  earliestDeliveryDate: CalendarDay | null;
  /** How long each quote above stays an offer. */
  quoteTtlSeconds: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Basket identity
// ---------------------------------------------------------------------------

/**
 * A digest of the basket a quote was priced for.
 *
 * Comparing digests is how checkout notices that a line was added in another
 * tab between the review screen and Pay. It covers the lines, their
 * quantities, the currency and the coupon - everything that decides *what* is
 * being bought.
 *
 * It deliberately does NOT cover the prices. A catalogue price that moved is a
 * different problem with a different answer: checkout re-prices and compares
 * the totals directly, so it can tell the customer what the figure was and
 * what it is now. Folding that into the hash would collapse both into "your
 * basket changed", which is not what happened and not something they can act
 * on.
 */
export function basketDigest(
  currency: string,
  items: readonly { productId: string; variantId: string | null; quantity: number }[],
  couponId: string | null,
): string {
  const canonical = items
    .map((item) => `${item.productId}:${variantKeyOf(item.variantId)}:${String(item.quantity)}`)
    .sort()
    .join('|');

  return createHash('sha256')
    .update(`${currency.toUpperCase()}#${couponId ?? ''}#${canonical}`)
    .digest('hex');
}

/** The digest of a resolved cart, from the rows the pricing run actually used. */
function digestOf(resolved: ResolvedCart): string {
  return basketDigest(
    resolved.currency,
    resolved.sourceItems.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
    })),
    resolved.appliedCoupon?.couponId ?? null,
  );
}

// ---------------------------------------------------------------------------
// Postal-code matching
// ---------------------------------------------------------------------------

/**
 * A postcode reduced to the only form two of them can be compared in.
 *
 * Upper case, with spaces and hyphens removed. "sw1a 1aa" and "SW1A1AA" are
 * the same place, and "80-601" written in Poland is "80601" written anywhere
 * else. Nothing else is normalised: a postcode is not a number and must not be
 * parsed as one.
 */
function normalisePostal(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Whether a lane covers a postcode.
 *
 * An empty prefix list means the whole country, which is the common case. A
 * non-empty list matches when the postcode starts with any one of its entries.
 * Prefixes rather than ranges, because a postal code is not a number: "SW1A"
 * minus "SW1" is not an arithmetic question.
 *
 * A lane WITH prefixes and a destination with NO postcode does not match. That
 * is the conservative direction on purpose - the estimate a buyer gets before
 * typing an address should not quote a lane that may turn out not to cover
 * them.
 */
export function zoneCoversPostal(postalPrefixes: string, postalCode: string | null): boolean {
  const prefixes = postalPrefixes
    .split(',')
    .map((entry) => normalisePostal(entry))
    .filter((entry) => entry.length > 0);

  if (prefixes.length === 0) return true;

  const normalised = normalisePostal(postalCode);
  if (normalised.length === 0) return false;

  return prefixes.some((prefix) => normalised.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// The quote
// ---------------------------------------------------------------------------

/** The town a warehouse dispatches from, out of its address JSON. */
function cityOf(addressJson: unknown): string | null {
  if (typeof addressJson !== 'object' || addressJson === null || Array.isArray(addressJson)) {
    return null;
  }

  const city = (addressJson as Record<string, unknown>)['city'];
  return typeof city === 'string' && city.trim().length > 0 ? city : null;
}

/** Add whole days, in working days or calendar days as the lane says. */
function advance(day: CalendarDay, days: number, useBusinessDays: boolean): CalendarDay {
  return useBusinessDays ? addBusinessDays(day, days) : addCalendarDays(day, days);
}

/**
 * How long an option has before it stops being an offer.
 *
 * Deployment-wide rather than per lane: it is a statement about how fast this
 * system's stock figures go stale, not about any particular carrier.
 */
export function quoteTtlMs(): number {
  return env.FULFILMENT_QUOTE_TTL_MINUTES * 60_000;
}

/** The destination, resolved from either an address or a bare country. */
async function resolveDestination(input: WarehouseOptionsInput): Promise<{
  countryCode: string;
  postalCode: string | null;
  addressId: string | null;
  point: { latitude: number; longitude: number } | null;
  timezone: string | null;
  isEstimate: boolean;
}> {
  const addressId = input.deliveryAddressId ?? null;

  if (addressId !== null) {
    const address = await prisma.address.findFirst({
      // Scoped by the customer, so one buyer cannot quote against another's
      // address by guessing an id. It 404s rather than 403s, for the same
      // reason every other customer-scoped read in this codebase does.
      where: { id: addressId, customerProfileId: input.customerProfileId, archivedAt: null },
      select: {
        id: true,
        country: true,
        postalCode: true,
        latitude: true,
        longitude: true,
        timezone: true,
      },
    });

    if (address === null) {
      throw badRequest(ErrorCode.ADDRESS_REQUIRED, 'Select a valid delivery address.', [
        { field: 'deliveryAddressId', code: 'NOT_FOUND' },
      ]);
    }

    const latitude = address.latitude === null ? null : Number(address.latitude);
    const longitude = address.longitude === null ? null : Number(address.longitude);

    return {
      countryCode: address.country.trim().toUpperCase(),
      postalCode: address.postalCode.trim().length === 0 ? null : address.postalCode.trim(),
      addressId: address.id,
      point:
        latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)
          ? null
          : { latitude, longitude },
      timezone: address.timezone,
      isEstimate: false,
    };
  }

  const countryCode = (input.countryCode ?? '').trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give a delivery address, or the two-letter country code to estimate against.',
      [{ field: 'deliveryAddressId', code: 'REQUIRED' }],
    );
  }

  return {
    countryCode,
    postalCode: null,
    addressId: null,
    point: null,
    timezone: null,
    isEstimate: true,
  };
}

/**
 * What this basket, to this address, can be delivered by - and on what terms.
 *
 * Answers with an empty `options` rather than throwing when nobody can serve
 * the destination: "we have no warehouse that ships to you" is a real answer
 * the storefront has a screen for, and turning it into an error would make it
 * indistinguishable from a request this endpoint could not understand.
 */
export async function quoteWarehouseOptions(
  input: WarehouseOptionsInput,
): Promise<WarehouseOptionsResult> {
  const now = input.now ?? new Date();
  const destination = await resolveDestination(input);

  // --- The basket, priced once, by the one engine ------------------------
  //
  // No shipping at all in this run. Each lane's fee is applied below through
  // `calculateShipping` - the same function `priceLines` itself calls - so the
  // free-above threshold behaves identically whether delivery came from a
  // shipping method or from a warehouse lane.
  const resolved = await resolveCart(input.customerProfileId, {
    destinationCountry: destination.countryCode,
  });

  if (resolved.sourceItems.length === 0) {
    throw badRequest(ErrorCode.CART_EMPTY, 'Your cart is empty.');
  }

  const currency = resolved.currency;

  if (
    input.currency !== undefined &&
    input.currency !== null &&
    input.currency.trim().toUpperCase() !== currency
  ) {
    throw conflict(
      ErrorCode.FULFILMENT_QUOTE_STALE,
      'Your basket is priced in a different currency now. Reload and choose again.',
      [{ field: 'currency', code: 'CHANGED', meta: { expected: currency } }],
    );
  }

  const basketHash = digestOf(resolved);

  // The browser's view of the basket, checked rather than trusted. A client
  // that disagrees with the server's cart is showing the customer something
  // that is no longer true, and answering for the basket it *thinks* it has
  // would put a total on screen for a cart nobody owns.
  if (input.items !== undefined) {
    const claimed = basketDigest(
      currency,
      input.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.quantity,
      })),
      resolved.appliedCoupon?.couponId ?? null,
    );

    if (claimed !== basketHash) {
      throw conflict(
        ErrorCode.FULFILMENT_QUOTE_STALE,
        'Your basket has changed. Reload it and choose a warehouse again.',
        [{ field: 'items', code: 'CHANGED' }],
      );
    }
  }

  const netSubtotalMinor =
    resolved.pricing.totals.subtotalMinor - resolved.pricing.totals.discountMinor;

  const items = resolved.sourceItems.map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
  }));

  const productIds = [...new Set(items.map((item) => item.productId))];

  // --- What the goods themselves refuse ----------------------------------
  const [products, restrictions, countryRow, business] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        name: true,
        sku: true,
        isStockTracked: true,
        requiresColdChain: true,
        weightGrams: true,
        variants: { select: { id: true, sku: true } },
      },
    }),
    prisma.productCountryRestriction.findMany({
      where: { productId: { in: productIds }, countryCode: destination.countryCode },
      select: { productId: true, reason: true },
    }),
    prisma.country.findUnique({
      where: { code: destination.countryCode },
      select: { name: true },
    }),
    prisma.businessProfile.findFirst({ select: { timezone: true } }),
  ]);

  const productById = new Map(products.map((product) => [product.id, product]));
  const restrictionByProduct = new Map(
    restrictions.map((entry) => [entry.productId, entry.reason]),
  );

  const restrictedLines: RestrictedLine[] = items
    .filter((item) => restrictionByProduct.has(item.productId))
    .map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      productName: productById.get(item.productId)?.name ?? item.productId,
      reason: restrictionByProduct.get(item.productId) ?? null,
    }));

  const needsColdChain = items.some(
    (item) => productById.get(item.productId)?.requiresColdChain === true,
  );

  /**
   * The basket's weight, or null when any line's is unrecorded.
   *
   * Null means "do not check", not "zero". A weight limit tested against a
   * total that silently omitted the one heavy line nobody measured would pass
   * every lane and then fail at the loading bay.
   */
  const totalWeightGrams = items.reduce<number | null>((total, item) => {
    if (total === null) return null;
    const grams = productById.get(item.productId)?.weightGrams ?? null;
    return grams === null ? null : total + grams * item.quantity;
  }, 0);

  // --- The candidates ----------------------------------------------------
  //
  // Filtered in SQL on the two things SQL can decide and the buyer has no
  // business hearing about: a warehouse that is switched off, and one under
  // MAINTENANCE or SUSPENDED. Neither reaches the geometry or the stock join,
  // and neither is named in the answer - "we have a depot near you but it is
  // closed for refurbishment" is the operator's business.
  //
  // **A missing lane is NOT filtered here**, deliberately. It used to be, and
  // the effect was that a warehouse with no delivery service to the buyer's
  // country simply vanished: not offered, and not explained either. Somebody
  // who knows there is a depot in their own city and cannot see it on the
  // list assumes the list is broken. It now falls through to the lane check
  // below and comes back as `NO_DELIVERY_ZONE`, which is a fact they can act
  // on - and which the storefront reads to tell "this shop does not do
  // warehouse fulfilment here" apart from "it does, and today it cannot".
  const warehouses = await prisma.inventoryLocation.findMany({
    where: {
      isActive: true,
      operationalStatus: { in: ['OPERATIONAL', 'LIMITED'] },
    },
    select: {
      id: true,
      code: true,
      name: true,
      countryCode: true,
      timezone: true,
      addressJson: true,
      latitude: true,
      longitude: true,
      operationalStatus: true,
      country: { select: { name: true } },
      exclusions: {
        where: { countryCode: destination.countryCode },
        select: { countryCode: true },
      },
      deliveryZones: {
        where: { countryCode: destination.countryCode, isActive: true },
        orderBy: [{ priority: 'asc' }, { transitMaxDays: 'asc' }],
      },
    },
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  });

  const balances =
    warehouses.length === 0
      ? []
      : await prisma.inventoryBalance.findMany({
          where: {
            locationId: { in: warehouses.map((warehouse) => warehouse.id) },
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

  const storeTimezone = business?.timezone ?? 'UTC';
  const requested = input.requestedDeliveryDate ?? null;

  /**
   * Each offer, with the two things the row write needs and the wire does not.
   *
   * A companion record rather than extra properties smuggled onto the option
   * itself: an object carrying fields the contract does not mention is an
   * object somebody eventually serialises whole.
   */
  const built: { option: WarehouseOption; zoneId: string; shippingMinor: Minor }[] = [];
  const ineligible: IneligibleWarehouse[] = [];

  for (const row of warehouses) {
    const view: OptionWarehouse = {
      id: row.id,
      code: row.code,
      name: row.name,
      countryCode: row.countryCode,
      countryName: row.country?.name ?? null,
      city: cityOf(row.addressJson),
      operationalStatus: row.operationalStatus,
    };

    /*
     * The goods themselves are refused by the destination.
     *
     * First, because it is the reason that dominates every other one: a
     * product that may not enter this country cannot be sent from anywhere,
     * and telling a buyer that Chennai happens to have no lane to them is
     * noise beside that. The same sentence goes against every warehouse, so
     * the list reads as one answer rather than as eight coincidences.
     *
     * Loop-invariant on purpose - `restrictedLines` is a fact about the cart
     * and the destination, not about this row - and repeated per warehouse so
     * the storefront's "why not" list is complete.
     */
    if (restrictedLines.length > 0) {
      ineligible.push({
        warehouse: view,
        reason: 'PRODUCT_RESTRICTED',
        message: 'One of these products cannot be delivered to your country.',
        shortLines: [],
      });
      continue;
    }

    // An operator closed this country on this warehouse. Reported to the
    // buyer as a fact and never with the operator's reason - "we could serve
    // you from Antwerp but choose not to" is worse than "this warehouse does
    // not serve your country".
    if (row.exclusions.length > 0) {
      ineligible.push({
        warehouse: view,
        reason: 'COUNTRY_CLOSED',
        message: 'This warehouse does not deliver to your country.',
        shortLines: [],
      });
      continue;
    }

    /*
     * --- The lanes -------------------------------------------------------
     *
     * Before the stock check, and the order is the point. "Chennai has no
     * delivery service to you" is true whatever Chennai holds on its shelves,
     * and reporting it as INSUFFICIENT_STOCK instead would send a buyer off
     * to reduce a quantity that was never the problem.
     *
     * Empty covers both halves of the same fact: no lane to this country at
     * all, and a lane whose postcode prefixes do not reach this address.
     */
    const lanes = row.deliveryZones.filter((zone) =>
      zoneCoversPostal(zone.postalPrefixes, destination.postalCode),
    );

    if (lanes.length === 0) {
      ineligible.push({
        warehouse: view,
        reason: 'NO_DELIVERY_ZONE',
        message: 'This warehouse has no delivery service covering your address.',
        shortLines: [],
      });
      continue;
    }

    // --- Stock, per line, at this building -------------------------------
    const lines: OptionLine[] = items.map((item) => {
      const product = productById.get(item.productId);
      const variant = product?.variants.find((entry) => entry.id === item.variantId);
      const availableQty =
        availableByKey.get(`${row.id}:${item.productId}:${variantKeyOf(item.variantId)}`) ?? 0;

      // A product nobody tracks the quantity of can be filled anywhere: there
      // is no number to be short of. A product this basket names that is not
      // in the catalogue is NOT silently fulfillable - it is reported short,
      // so the problem is visible rather than papered over.
      const isStockTracked = product?.isStockTracked ?? true;

      return {
        productId: item.productId,
        variantId: item.variantId,
        productName: product?.name ?? item.productId,
        sku: variant?.sku ?? product?.sku ?? item.productId,
        quantity: item.quantity,
        availableQty,
        isStockTracked,
        isFulfillable:
          product !== undefined && (!isStockTracked || availableQty >= item.quantity),
      };
    });

    const shortLines = lines.filter((line) => !line.isFulfillable);

    if (shortLines.length > 0) {
      ineligible.push({
        warehouse: view,
        reason: 'INSUFFICIENT_STOCK',
        message: 'This warehouse cannot cover the whole order.',
        shortLines,
      });
      continue;
    }

    // --- How far away it is. Information, not a rule ---------------------
    const position = classifyCoordinates(row);
    const distanceKm =
      position.latitude === null || position.longitude === null
        ? null
        : destination.point === null
          ? distanceToCountryKm(
              { latitude: position.latitude, longitude: position.longitude },
              destination.countryCode,
            )
          : greatCircleKm(
              { latitude: position.latitude, longitude: position.longitude },
              destination.point,
            );

    // Every reason a lane was refused, so a warehouse whose only lane is
    // unusable says why rather than disappearing.
    const laneRefusals: IneligibleWarehouse[] = [];
    let offered = 0;

    const warehouseTimezone = resolveTimezone(row.timezone, destination.timezone, storeTimezone);
    const today = todayIn(warehouseTimezone, now);

    for (const zone of lanes) {
      if (zone.shippingFeeCurrency.toUpperCase() !== currency) {
        laneRefusals.push({
          warehouse: view,
          reason: 'CURRENCY_MISMATCH',
          message: `This warehouse prices delivery in ${zone.shippingFeeCurrency}, and your basket is in ${currency}.`,
          shortLines: [],
        });
        continue;
      }

      if (needsColdChain && !zone.supportsColdChain) {
        laneRefusals.push({
          warehouse: view,
          reason: 'COLD_CHAIN_UNSUPPORTED',
          message: 'This delivery service cannot carry refrigerated goods.',
          shortLines: [],
        });
        continue;
      }

      if (
        zone.maxWeightGrams !== null &&
        totalWeightGrams !== null &&
        totalWeightGrams > zone.maxWeightGrams
      ) {
        laneRefusals.push({
          warehouse: view,
          reason: 'OVER_WEIGHT',
          message: 'This order is heavier than this delivery service accepts.',
          shortLines: [],
        });
        continue;
      }

      const dispatchDate = advance(today, zone.handlingDays, zone.usesBusinessDays);
      const deliveryFromDate = advance(dispatchDate, zone.transitMinDays, zone.usesBusinessDays);
      const deliveryToDate = advance(dispatchDate, zone.transitMaxDays, zone.usesBusinessDays);

      const shippingMinor: Minor = calculateShipping(
        { priceMinor: zone.shippingFeeMinor, freeAboveMinor: zone.freeAboveMinor },
        netSubtotalMinor,
      );

      // The base run priced with no delivery at all, so the grand total is the
      // line totals. Adding this lane's shipping to it is the same arithmetic
      // `priceLines` performs - see `calculateShipping` above, which is the
      // function it calls.
      const grandTotalMinor = resolved.pricing.totals.grandTotalMinor + shippingMinor;

      built.push({
        zoneId: zone.id,
        shippingMinor,
        option: {
          quoteId: newId(),
          // Stamped below, once every option is known, so a page of options
          // all lapse together rather than one at a time.
          expiresAt: '',
          warehouse: view,
          distanceKm,
          lines,
          carrier: { name: zone.carrierName, serviceLevel: zone.serviceLevel },
          handlingDays: zone.handlingDays,
          usesBusinessDays: zone.usesBusinessDays,
          transitDays: { min: zone.transitMinDays, max: zone.transitMaxDays },
          dispatchDate,
          deliveryFromDate,
          deliveryToDate,
          meetsRequestedDate: requested === null ? null : deliveryToDate <= requested,
          currency,
          totals: {
            subtotal: serialiseMoney(resolved.pricing.totals.subtotalMinor, currency),
            discount: serialiseMoney(resolved.pricing.totals.discountMinor, currency),
            tax: serialiseMoney(resolved.pricing.totals.taxMinor, currency),
            shipping: serialiseMoney(shippingMinor, currency),
            grandTotal: serialiseMoney(grandTotalMinor, currency),
          },
          isFastest: false,
          isCheapest: false,
          isRecommended: false,
        },
      });

      offered += 1;
    }

    // A warehouse whose every lane was refused says why. Only the first
    // reason: three cards saying the same thing about one building is noise,
    // and the reasons for the lanes of one warehouse are almost always the
    // same reason.
    if (offered === 0 && laneRefusals.length > 0) {
      const first = laneRefusals[0];
      if (first !== undefined) ineligible.push(first);
    }
  }

  // --- Badges ------------------------------------------------------------
  //
  // The companion list is what gets sorted, so every offer stays beside the
  // lane it came from and the row write below cannot pair one with another
  // lane's fee.
  rankOptions(built);

  const options = built.map((entry) => entry.option);

  // --- Freeze the offers -------------------------------------------------
  const expiresAt = new Date(now.getTime() + quoteTtlMs());
  const expiresAtIso = expiresAt.toISOString();

  for (const option of options) option.expiresAt = expiresAtIso;

  if (built.length > 0) {
    await prisma.fulfilmentQuote.createMany({
      data: built.map(({ option, zoneId, shippingMinor }) => ({
        id: option.quoteId,
        customerProfileId: input.customerProfileId,
        cartId: resolved.cartId,
        addressId: destination.addressId,
        locationId: option.warehouse.id,
        zoneId,
        destinationCountry: destination.countryCode,
        destinationPostalCode: destination.postalCode,
        isEstimate: destination.isEstimate,
        currency,
        subtotalMinor: resolved.pricing.totals.subtotalMinor,
        discountMinor: resolved.pricing.totals.discountMinor,
        taxMinor: resolved.pricing.totals.taxMinor,
        shippingMinor,
        grandTotalMinor: resolved.pricing.totals.grandTotalMinor + shippingMinor,
        dispatchDate: toDateColumn(option.dispatchDate),
        deliveryFromDate: toDateColumn(option.deliveryFromDate),
        deliveryToDate: toDateColumn(option.deliveryToDate),
        transitMinDays: option.transitDays.min,
        transitMaxDays: option.transitDays.max,
        handlingDays: option.handlingDays,
        carrierName: option.carrier.name,
        serviceLevel: option.carrier.serviceLevel,
        distanceKm: option.distanceKm === null ? null : option.distanceKm.toFixed(2),
        basketHash,
        itemsJson: items as never,
        expiresAt,
      })),
    });
  }

  const earliest = options.reduce<CalendarDay | null>(
    (best, option) =>
      best === null || option.deliveryFromDate < best ? option.deliveryFromDate : best,
    null,
  );

  return {
    destination: {
      countryCode: destination.countryCode,
      countryName: countryRow?.name ?? destination.countryCode,
      postalCode: destination.postalCode,
      addressId: destination.addressId,
    },
    isEstimate: destination.isEstimate,
    currency,
    options,
    ineligible,
    restrictedLines,
    earliestDeliveryDate: earliest,
    quoteTtlSeconds: Math.round(quoteTtlMs() / 1000),
    computedAt: now.toISOString(),
  };
}

/**
 * Order the options and mark the three badges.
 *
 * Sorted fastest first, then cheapest, then nearest - which is a presentation
 * and not a decision. Nothing here picks an option *for* the buyer except
 * `isRecommended`, which names the default so an already-selected card can say
 * why it is selected.
 */
function rankOptions(entries: { option: WarehouseOption }[]): void {
  entries.sort(({ option: a }, { option: b }) => {
    if (a.deliveryToDate !== b.deliveryToDate) return a.deliveryToDate < b.deliveryToDate ? -1 : 1;

    const aTotal = BigInt(a.totals.grandTotal.minor);
    const bTotal = BigInt(b.totals.grandTotal.minor);
    if (aTotal !== bTotal) return aTotal < bTotal ? -1 : 1;

    return (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY);
  });

  const options = entries.map((entry) => entry.option);

  const fastest = options[0];
  if (fastest === undefined) return;

  let cheapest = fastest;
  for (const option of options) {
    if (BigInt(option.totals.grandTotal.minor) < BigInt(cheapest.totals.grandTotal.minor)) {
      cheapest = option;
    }
  }

  fastest.isFastest = true;
  cheapest.isCheapest = true;

  /**
   * The default, and the rule behind it stated out loud: the cheapest option
   * that arrives within a day of the soonest.
   *
   * A day, because that is the trade most people make by hand - nobody pays a
   * premium to save an afternoon, and few will wait a week to save it either.
   * It frequently lands on the fastest or the cheapest, and that is fine: the
   * card then carries two badges, which is true rather than redundant.
   */
  const grace = addCalendarDays(fastest.deliveryToDate, 1);
  const within = options.filter((option) => option.deliveryToDate <= grace);

  let recommended = within[0] ?? fastest;
  for (const option of within) {
    if (BigInt(option.totals.grandTotal.minor) < BigInt(recommended.totals.grandTotal.minor)) {
      recommended = option;
    }
  }

  recommended.isRecommended = true;
}

// ---------------------------------------------------------------------------
// Binding a quote
// ---------------------------------------------------------------------------

/** Everything checkout freezes onto the order, once a quote has been accepted. */
export interface UsableQuote {
  quoteId: string;
  locationId: string;
  locationName: string;
  carrierName: string;
  serviceLevel: string;
  dispatchDate: Date;
  deliveryFromDate: Date;
  deliveryToDate: Date;
  currency: string;
  /** The delivery fee, to be handed back into the pricing run. */
  shippingMinor: Minor;
  freeAboveMinor: Minor | null;
  grandTotalMinor: Minor;
}

/**
 * Re-check an offer against the world, immediately before money moves.
 *
 * This is the function that makes a quote safe to have written down. Every
 * check is a way the world can move between the review screen and Pay, and
 * every one of them refuses with its own code rather than repricing:
 *
 *   1. **Is it theirs, and is it an offer at all?** An estimate taken against
 *      a country is not, and neither is somebody else's id.
 *   2. **Has it lapsed?** Stock is the fastest-moving figure in this system.
 *   3. **Is it for this basket, and this address?** A line added in another
 *      tab makes the offer one for a different basket.
 *   4. **Can the warehouse still ship?** It may have gone into maintenance,
 *      been retired, or had its lane closed.
 *   5. **Is the stock still there?** Somebody else may have bought it. The
 *      detail names the lines and the quantities - never a bare "out of
 *      stock", and never a silent move to another warehouse.
 *
 * Price drift is deliberately NOT checked here. `submitCheckout` re-prices
 * through `resolveCart` with this quote's fee applied and compares the totals
 * itself, so it can tell the customer what the figure was and what it is now -
 * which is a different sentence from "your basket changed".
 */
export async function assertQuoteUsable(params: {
  quoteId: string;
  customerProfileId: string;
  cartId: string;
  addressId: string;
  basketHash: string;
  now?: Date;
}): Promise<UsableQuote> {
  const now = params.now ?? new Date();

  const quote = await prisma.fulfilmentQuote.findFirst({
    // Ownership is the `where` clause, as everywhere else. A quote belonging
    // to somebody else simply does not match.
    where: { id: params.quoteId, customerProfileId: params.customerProfileId },
    include: {
      location: {
        select: { id: true, name: true, isActive: true, operationalStatus: true },
      },
      zone: true,
    },
  });

  if (quote === null) {
    throw badRequest(
      ErrorCode.FULFILMENT_QUOTE_INVALID,
      'That delivery option is no longer available. Choose one again.',
      [{ field: 'fulfilmentQuoteId', code: 'NOT_FOUND' }],
    );
  }

  if (quote.isEstimate) {
    throw badRequest(
      ErrorCode.FULFILMENT_QUOTE_INVALID,
      'That was an estimate rather than an offer. Choose a delivery option for this address.',
      [{ field: 'fulfilmentQuoteId', code: 'ESTIMATE' }],
    );
  }

  if (quote.expiresAt.getTime() <= now.getTime()) {
    throw conflict(
      ErrorCode.FULFILMENT_QUOTE_EXPIRED,
      'That delivery option has expired. Here are the current ones.',
      [{ field: 'fulfilmentQuoteId', code: 'EXPIRED' }],
    );
  }

  if (quote.addressId !== params.addressId) {
    throw conflict(
      ErrorCode.FULFILMENT_QUOTE_INVALID,
      'That delivery option was for a different address. Choose one for this address.',
      [{ field: 'fulfilmentQuoteId', code: 'ADDRESS_CHANGED' }],
    );
  }

  if (quote.cartId !== null && quote.cartId !== params.cartId) {
    throw conflict(
      ErrorCode.FULFILMENT_QUOTE_STALE,
      'That delivery option was for a different basket. Choose one again.',
      [{ field: 'fulfilmentQuoteId', code: 'CART_CHANGED' }],
    );
  }

  if (quote.basketHash !== params.basketHash) {
    throw conflict(
      ErrorCode.FULFILMENT_QUOTE_STALE,
      'Your basket changed after you chose a delivery option. Choose one again.',
      [{ field: 'fulfilmentQuoteId', code: 'BASKET_CHANGED' }],
    );
  }

  const canShip =
    quote.location.isActive &&
    (quote.location.operationalStatus === 'OPERATIONAL' ||
      quote.location.operationalStatus === 'LIMITED');

  if (!canShip) {
    throw conflict(
      ErrorCode.FULFILMENT_WAREHOUSE_UNAVAILABLE,
      `${quote.location.name} cannot dispatch at the moment. Choose another delivery option.`,
      [{ field: 'fulfilmentQuoteId', code: 'WAREHOUSE_UNAVAILABLE' }],
    );
  }

  // The lane. Null where an operator retired the carrier since - the fee and
  // the dates are still frozen on the quote, but nothing stands behind them
  // any more, so the offer is withdrawn rather than honoured against a service
  // that no longer exists.
  if (quote.zone === null || !quote.zone.isActive) {
    throw conflict(
      ErrorCode.FULFILMENT_WAREHOUSE_UNAVAILABLE,
      'That delivery service is no longer offered. Choose another delivery option.',
      [{ field: 'fulfilmentQuoteId', code: 'ZONE_WITHDRAWN' }],
    );
  }

  // --- Stock, one last time ----------------------------------------------
  const lines = Array.isArray(quote.itemsJson) ? (quote.itemsJson as unknown[]) : [];

  const wanted: { productId: string; variantId: string | null; quantity: number }[] = [];

  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) continue;
    const line = raw as { productId?: unknown; variantId?: unknown; quantity?: unknown };
    if (typeof line.productId !== 'string' || typeof line.quantity !== 'number') continue;

    wanted.push({
      productId: line.productId,
      variantId: typeof line.variantId === 'string' ? line.variantId : null,
      quantity: line.quantity,
    });
  }

  if (wanted.length > 0) {
    const [products, balances] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: [...new Set(wanted.map((line) => line.productId))] } },
        select: { id: true, name: true, isStockTracked: true },
      }),
      prisma.inventoryBalance.findMany({
        where: {
          locationId: quote.locationId,
          productId: { in: [...new Set(wanted.map((line) => line.productId))] },
        },
        select: { productId: true, variantKey: true, onHandQty: true, reservedQty: true },
      }),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const availableByKey = new Map(
      balances.map((balance) => [
        `${balance.productId}:${balance.variantKey}`,
        balance.onHandQty - balance.reservedQty,
      ]),
    );

    const short = wanted
      .map((line) => {
        const product = productById.get(line.productId);
        if (product === undefined || !product.isStockTracked) return null;

        const availableQty =
          availableByKey.get(`${line.productId}:${variantKeyOf(line.variantId)}`) ?? 0;

        return availableQty >= line.quantity
          ? null
          : {
              field: 'fulfilmentQuoteId',
              code: 'INSUFFICIENT_STOCK',
              message: `${product.name}: ${String(availableQty)} left at ${quote.location.name}, ${String(line.quantity)} wanted.`,
              meta: { productId: line.productId, availableQty, wanted: line.quantity },
            };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (short.length > 0) {
      throw conflict(
        ErrorCode.FULFILMENT_STOCK_CHANGED,
        `${quote.location.name} can no longer cover this order. Choose another delivery option.`,
        short,
      );
    }
  }

  return {
    quoteId: quote.id,
    locationId: quote.locationId,
    locationName: quote.location.name,
    carrierName: quote.carrierName,
    serviceLevel: quote.serviceLevel,
    dispatchDate: quote.dispatchDate,
    deliveryFromDate: quote.deliveryFromDate,
    deliveryToDate: quote.deliveryToDate,
    currency: quote.currency,
    // Taken from the LANE rather than from the quote's own `shippingMinor`, so
    // the re-priced run applies the free-above threshold against the basket as
    // it stands now. The quote's figure is what the customer was shown, and
    // `submitCheckout` compares the two - a difference is reported, never
    // absorbed.
    shippingMinor: quote.zone.shippingFeeMinor,
    freeAboveMinor: quote.zone.freeAboveMinor,
    grandTotalMinor: quote.grandTotalMinor,
  };
}

/**
 * A quote the customer can read back, for the storefront's own revalidation.
 *
 * The checkout page asks for this before it enables Pay, so a page left open
 * over lunch discovers the problem where it can be fixed rather than at the
 * moment money would move. It returns the reason rather than throwing: a
 * screen that has to catch an exception to render "this has expired" is a
 * screen that will render a stack trace one day.
 */
export interface QuoteCheck {
  ok: boolean;
  quoteId: string;
  /** The error code that would be raised at checkout. Null when it is fine. */
  code: string | null;
  message: string | null;
  expiresAt: string;
}

export async function checkQuote(params: {
  quoteId: string;
  customerProfileId: string;
  cartId: string;
  addressId: string;
  basketHash: string;
  now?: Date;
}): Promise<QuoteCheck> {
  try {
    const usable = await assertQuoteUsable(params);
    const quote = await prisma.fulfilmentQuote.findUniqueOrThrow({
      where: { id: usable.quoteId },
      select: { expiresAt: true },
    });

    return {
      ok: true,
      quoteId: params.quoteId,
      code: null,
      message: null,
      expiresAt: quote.expiresAt.toISOString(),
    };
  } catch (error) {
    // Only the refusals this module raises become an answer. A dropped
    // connection or a bug is a fault and travels as one - swallowing it here
    // would turn "the database is down" into "your delivery option expired",
    // which is a lie the customer would act on.
    if (isAppError(error) && error.code.startsWith('FULFILMENT_')) {
      return {
        ok: false,
        quoteId: params.quoteId,
        code: error.code,
        message: error.message,
        // Zero rather than the row's own expiry: the row may be gone, and a
        // plausible-looking date beside `ok: false` invites a screen to count
        // down to it.
        expiresAt: new Date(0).toISOString(),
      };
    }

    throw error;
  }
}

/**
 * The digest of a customer's live cart, for the two callers that need one.
 *
 * Exported so checkout and the revalidation endpoint ask the same question of
 * the same rows rather than each assembling their own idea of what the basket
 * is.
 */
export async function currentBasketDigest(customerProfileId: string): Promise<{
  cartId: string;
  basketHash: string;
  resolved: ResolvedCart;
}> {
  const resolved = await resolveCart(customerProfileId);
  return { cartId: resolved.cartId, basketHash: digestOf(resolved), resolved };
}

/** The digest of an already-resolved cart, without resolving it twice. */
export function digestOfResolvedCart(resolved: ResolvedCart): string {
  return digestOf(resolved);
}

/**
 * The soonest one warehouse could get something to one destination.
 *
 * `dispatch + the shortest transit`, over that warehouse's best lane to the
 * postcode, counted on the warehouse's own clock and in working days where
 * the lane says so. Null when the warehouse publishes no lane there - and
 * null means "this adds no constraint", not "it can go tomorrow": the caller
 * is left with whatever floor it already had.
 *
 * Used by the scheduling rule rather than by checkout. A standing order that
 * names a warehouse has two floors under its first delivery - the notice
 * period the business promises itself, and what the building can physically
 * reach - and `effectiveEarliestDelivery` is where the two meet. Checkout
 * gets the whole option from `quoteWarehouseOptions` instead; this is the one
 * figure out of it that a date picker needs.
 */
export async function earliestDeliveryFromWarehouse(params: {
  locationId: string;
  countryCode: string;
  postalCode: string | null;
  /** The store's zone, used only where the warehouse has none of its own. */
  fallbackTimezone: string;
  now?: Date;
}): Promise<CalendarDay | null> {
  const now = params.now ?? new Date();

  const warehouse = await prisma.inventoryLocation.findFirst({
    where: { id: params.locationId, isActive: true },
    select: {
      timezone: true,
      deliveryZones: {
        where: { countryCode: params.countryCode.trim().toUpperCase(), isActive: true },
      },
    },
  });

  if (warehouse === null) return null;

  const lanes = warehouse.deliveryZones.filter((zone) =>
    zoneCoversPostal(zone.postalPrefixes, params.postalCode),
  );

  if (lanes.length === 0) return null;

  const timezone = resolveTimezone(warehouse.timezone, params.fallbackTimezone);
  const today = todayIn(timezone, now);

  // The soonest across every lane, because the buyer may pick any of them.
  // Taking the *slowest* would hold a date picker to a premium service nobody
  // chose, and taking one arbitrarily would make the floor depend on the row
  // order.
  let soonest: CalendarDay | null = null;

  for (const zone of lanes) {
    const dispatch = advance(today, zone.handlingDays, zone.usesBusinessDays);
    const arrival = advance(dispatch, zone.transitMinDays, zone.usesBusinessDays);
    if (soonest === null || arrival < soonest) soonest = arrival;
  }

  return soonest;
}

/**
 * Clear out offers nobody took.
 *
 * A quote that has lapsed and that no order points at is dead weight - it is
 * an offer that can never be accepted. One attached to an order is kept for
 * ever: it is the evidence of what the customer was shown before they agreed
 * to pay, and the foreign key is RESTRICT precisely so this sweep cannot take
 * it by accident.
 *
 * A grace period past expiry, so a quote that lapsed while somebody was
 * pressing Pay is still there to produce FULFILMENT_QUOTE_EXPIRED - which is a
 * far better answer than FULFILMENT_QUOTE_INVALID, because it tells the buyer
 * the option was real and simply got old.
 */
export async function sweepExpiredFulfilmentQuotes(now: Date = new Date()): Promise<{
  removed: number;
}> {
  const GRACE_MS = 60 * 60 * 1000;

  const result = await prisma.fulfilmentQuote.deleteMany({
    where: {
      expiresAt: { lt: new Date(now.getTime() - GRACE_MS) },
      orders: { none: {} },
    },
  });

  return { removed: result.count };
}

/** A quote as the wire reports it, for the order and audit trail. */
export function serialiseQuoteForAudit(quote: UsableQuote): Record<string, unknown> {
  return {
    quoteId: quote.quoteId,
    warehouseId: quote.locationId,
    warehouseName: quote.locationName,
    carrier: quote.carrierName,
    serviceLevel: quote.serviceLevel,
    dispatchDate: fromDateColumn(quote.dispatchDate),
    deliveryFrom: fromDateColumn(quote.deliveryFromDate),
    deliveryTo: fromDateColumn(quote.deliveryToDate),
    currency: quote.currency,
    quotedGrandTotalMinor: quote.grandTotalMinor.toString(),
  };
}
