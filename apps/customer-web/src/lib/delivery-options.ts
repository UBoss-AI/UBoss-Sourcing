/**
 * Who can deliver this basket, and on what terms.
 *
 * Mirrors `backend/src/modules/inventory/delivery-options.service.ts`, and the
 * shape carries three things a buyer's screen has to be able to say that a
 * simpler one could not:
 *
 *   - **`options` and `partial` are separate lists.** A warehouse in range
 *     that holds only three of the four things in the basket cannot deliver
 *     it, and mixing it in with the ones that can would be an offer that
 *     breaks at the picking face. It is still returned, because "Antwerp has
 *     most of this" is useful to somebody who can split an order and useless
 *     if it is hidden.
 *   - **`leadTimeDays` and `fee` are nullable, and nothing substitutes for
 *     them.** A warehouse whose terms nobody has published is not offered as
 *     "3-5 days, free": the screen says the terms have not been published. A
 *     delivery promise invented by software is a promise nobody agreed to.
 *   - **`closedByOperator` is a count and never a list.** It exists so the
 *     storefront can tell "nobody is near enough" from "nobody serves your
 *     country" - two different sentences with two different next steps - and
 *     it carries no reason, because a buyer has no business reading why a
 *     seller will not ship to their country.
 */
import { api } from '@/lib/api';
import type { Money } from '@/lib/types';

/** One line of the basket, judged against one warehouse. */
export interface DeliveryOptionLine {
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

/** Can this warehouse ship today? `LIMITED` can, and says so. */
export type WarehouseOperationalStatus = 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';

export interface DeliveryOption {
  warehouse: {
    id: string;
    code: string;
    name: string;
    countryCode: string | null;
    countryName: string | null;
    /** The town it dispatches from, for "ships from". */
    city: string | null;
    operationalStatus: WarehouseOperationalStatus;
  };
  /**
   * Kilometres from the warehouse to the destination country's nearest border.
   *
   * Zero for a warehouse inside the destination country. **Not a distance to
   * the buyer's own address**: an option is offered before an address is
   * chosen, and a promise that changed once a postcode was typed would be a
   * different promise.
   */
  distanceKm: number;
  /** The geofence this option passed. */
  radiusKm: number;
  leadTimeDays: { min: number; max: number } | null;
  fee: Money | null;
  canFulfilAll: boolean;
  fulfillableLines: number;
  lines: DeliveryOptionLine[];
  isFastest: boolean;
  isCheapest: boolean;
}

export interface DeliveryOptionsResponse {
  destination: { countryCode: string; countryName: string };
  options: DeliveryOption[];
  partial: DeliveryOption[];
  closedByOperator: number;
  computedAt: string;
}

export interface DeliveryOptionsRequest {
  countryCode: string;
  items: { productId: string; variantId: string | null; quantity: number }[];
}

export function deliveryOptionsQueryKey(request: DeliveryOptionsRequest): readonly unknown[] {
  return ['delivery-options', request.countryCode, request.items];
}

export function fetchDeliveryOptions(
  request: DeliveryOptionsRequest,
): Promise<DeliveryOptionsResponse> {
  return api.post<DeliveryOptionsResponse>('/delivery/options', request);
}
