/**
 * Which warehouse this order leaves from, and on what terms.
 *
 * Mirrors `backend/src/modules/fulfilment/warehouse-options.service.ts`. The
 * shape is wider than `lib/delivery-options.ts` and the two are not the same
 * question:
 *
 *   - **`/delivery/options` is a browsing answer.** Public, priced from a
 *     country, no account needed. It tells a shopper on the cart page that
 *     Belgium is reachable and roughly when.
 *   - **`/fulfilment/warehouse-options` is a buying answer.** It prices *this
 *     customer's* basket to *one of their own addresses*, and every option
 *     comes back with a `quoteId` that checkout will take. That id names a
 *     stored offer with an expiry, which is what makes the number on the card
 *     the number that gets charged rather than a second guess at it.
 *
 * Three things this module deliberately does not do:
 *
 * **It computes nothing.** No totals are added up here, no arrival date is
 * derived from a transit range, no option is scored. Every figure below is the
 * server's, including which option is fastest, cheapest and recommended — a
 * second implementation of "which of these is best" is how a badge ends up on
 * a card whose price says otherwise.
 *
 * **It never treats an estimate as an offer.** `isEstimate` marks an answer
 * priced from a country because no address was given. The server refuses such
 * a quote at checkout, so the screen must not offer it as selectable.
 *
 * **It does not cache.** Availability is the fastest-moving input in this
 * system — it changes every time anybody else checks out — and a held answer
 * saying "Pune has it, Thursday" is the one answer that must never be stale.
 */
import { api } from '@/lib/api';
import type { Money } from '@/lib/types';

/** Can this warehouse ship today? `LIMITED` can, and the card says so. */
export type WarehouseOperationalStatus = 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';

export interface OptionWarehouse {
  id: string;
  code: string;
  name: string;
  /** ISO 3166-1 alpha-2 of the warehouse's own country, for a flag. */
  countryCode: string | null;
  countryName: string | null;
  /** The town it dispatches from, for "ships from". */
  city: string | null;
  operationalStatus: WarehouseOperationalStatus;
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
  /** Kilometres to the destination, or null where it could not be measured. */
  distanceKm: number | null;

  /** Every line covered in full. An option is never offered otherwise. */
  lines: OptionLine[];

  carrier: { name: string; serviceLevel: string };
  /** Days between the order and the box leaving the building. */
  handlingDays: number;
  /** Whether the day counts skip weekends. */
  usesBusinessDays: boolean;
  transitDays: { min: number; max: number };
  /** `YYYY-MM-DD`, on the warehouse's own clock. */
  dispatchDate: string;
  deliveryFromDate: string;
  deliveryToDate: string;
  /** Whether this lane can make the date asked for. Null when none was. */
  meetsRequestedDate: boolean | null;

  currency: string;
  totals: {
    subtotal: Money;
    discount: Money;
    tax: Money;
    shipping: Money;
    grandTotal: Money;
  };

  isFastest: boolean;
  isCheapest: boolean;
  isRecommended: boolean;
}

/** Why a warehouse the buyer might have expected is not on the list. */
export type IneligibleReason =
  | 'NO_DELIVERY_ZONE'
  | 'COUNTRY_CLOSED'
  | 'INSUFFICIENT_STOCK'
  | 'PRODUCT_RESTRICTED'
  | 'COLD_CHAIN_UNSUPPORTED'
  | 'OVER_WEIGHT'
  | 'CURRENCY_MISMATCH'
  | 'NOT_PLACED';

export interface IneligibleWarehouse {
  warehouse: OptionWarehouse;
  reason: IneligibleReason;
  message: string;
  /** The lines it is short of, named with quantities. Empty for other reasons. */
  shortLines: OptionLine[];
}

/** A line the destination itself refuses, whatever warehouse it leaves. */
export interface RestrictedLine {
  productId: string;
  variantId: string | null;
  productName: string;
  reason: string | null;
}

export interface WarehouseOptionsResponse {
  destination: {
    countryCode: string;
    countryName: string;
    postalCode: string | null;
    addressId: string | null;
  };
  /** Priced from a country rather than an address. Never selectable. */
  isEstimate: boolean;
  currency: string;
  /** Fastest first, then cheapest, then nearest. */
  options: WarehouseOption[];
  ineligible: IneligibleWarehouse[];
  restrictedLines: RestrictedLine[];
  earliestDeliveryDate: string | null;
  quoteTtlSeconds: number;
  computedAt: string;
}

export interface WarehouseOptionsRequest {
  /** The address this is going to. The only form checkout will accept. */
  deliveryAddressId?: string;
  /** Where the buyer is, when that is all they have said. Produces an estimate. */
  countryCode?: string;
  items?: { productId: string; variantId: string | null; quantity: number }[];
  currency?: string;
  /** `YYYY-MM-DD`. "Can you make the 24th?" */
  requestedDeliveryDate?: string;
}

/**
 * The answer to "is the option I chose still an offer?".
 *
 * `ok: false` with a code is a normal answer and not a thrown error — see the
 * route's own note. A screen that has to catch an exception to render "this
 * expired" is a screen that renders a stack trace one day.
 */
export interface QuoteCheck {
  ok: boolean;
  quoteId: string;
  /** The error code checkout would raise. Null when the offer stands. */
  code: string | null;
  message: string | null;
  expiresAt: string;
}

/**
 * The query key for a set of options.
 *
 * Keyed on everything that changes the answer — the address, the basket, the
 * currency — so choosing a different address asks a new question rather than
 * putting a new label on a stale one.
 */
export function warehouseOptionsQueryKey(request: WarehouseOptionsRequest): readonly unknown[] {
  return [
    'warehouse-options',
    request.deliveryAddressId ?? null,
    request.countryCode ?? null,
    request.currency ?? null,
    request.requestedDeliveryDate ?? null,
    request.items ?? null,
  ];
}

export function fetchWarehouseOptions(
  request: WarehouseOptionsRequest,
): Promise<WarehouseOptionsResponse> {
  return api.post<WarehouseOptionsResponse>('/fulfilment/warehouse-options', request);
}

/** Ask whether one quote is still good, just before money would move. */
export function revalidateQuote(quoteId: string, deliveryAddressId: string): Promise<QuoteCheck> {
  return api.post<QuoteCheck>(
    `/fulfilment/warehouse-options/${encodeURIComponent(quoteId)}/revalidate`,
    { deliveryAddressId },
  );
}

/**
 * Seconds until an offer lapses, floored at zero.
 *
 * Zero is the honest answer for a quote whose moment has passed, and it is
 * what a countdown renders as "expired" rather than as a negative number.
 */
export function secondsUntil(expiresAt: string, now: number = Date.now()): number {
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return 0;

  return Math.max(0, Math.floor((at - now) / 1000));
}
