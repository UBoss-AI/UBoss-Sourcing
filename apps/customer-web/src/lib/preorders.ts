/**
 * Bulk preorders: the storefront's and the Seller Hub's client.
 *
 * Nothing here computes a price, a minimum or a date. Every figure a buyer or a
 * seller sees comes from the server - the eligibility answer, the preview, or
 * the request itself - so the product page, the form and the seller's inbox
 * all show the numbers the server will hold them to.
 */
import { api, newIdempotencyKey } from './api';
import type { Money } from './format';

export type PreorderUnit = 'PIECE' | 'CARTON' | 'UK_PALLET' | 'US_PALLET' | 'CONTAINER';

export const PREORDER_UNITS: readonly PreorderUnit[] = [
  'PIECE',
  'CARTON',
  'UK_PALLET',
  'US_PALLET',
  'CONTAINER',
];

export type PreorderStatus =
  | 'SUBMITTED'
  | 'SELLER_REVIEW_REQUIRED'
  | 'SELLER_ACCEPTED'
  | 'SELLER_COUNTERED'
  | 'BUYER_CONFIRMED'
  | 'PAYMENT_REQUIRED'
  | 'CONFIRMED'
  | 'IN_PRODUCTION'
  | 'READY_FOR_FULFILLMENT'
  | 'CONVERTED_TO_ORDER'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export type IneligibleReason =
  | 'NOT_MARKETPLACE'
  | 'NOT_CONFIGURED'
  | 'DISABLED'
  | 'INCOMPLETE'
  | 'OFFER_INACTIVE'
  | 'VARIANT_INACTIVE'
  | 'SELLER_SUSPENDED';

export type Eligibility =
  | {
      available: true;
      offerId: string;
      sellerName: string;
      currency: string;
      listUnitPriceMinor: string;
      instantStockBaseUnits: number;
      units: { unit: PreorderUnit; baseUnits: number }[];
      moq: {
        unit: PreorderUnit;
        quantity: number;
        incrementQuantity: number;
        maxQuantity: number | null;
        minimumBaseUnits: number;
        incrementBaseUnits: number;
        maximumBaseUnits: number | null;
      };
      pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
      tiers: { minBaseUnits: number; unitPriceMinor: string }[];
      window: {
        today: string;
        earliest: string;
        latest: string | null;
        decidedBy: 'NOTICE' | 'PRODUCTION' | 'ROUTE';
        timezone: string;
        hasPublishedTransit: boolean;
      };
      deliveryCountries: string[];
      allowPartialFulfilment: boolean;
      allowSplitDelivery: boolean;
      cancellationTerms: string | null;
      specialInstructions: string | null;
    }
  | {
      available: false;
      reason: IneligibleReason;
      message: string;
      offerId: string | null;
      sellerName: string | null;
    };

/**
 * The quantity, in the minimum's unit, that the form opens on: the pieces the
 * buyer typed, rounded UP to a whole unit and onto the seller's steps above
 * the minimum, and held under the maximum. Never less than the minimum - a
 * form that opens on a quantity the seller refuses teaches nothing.
 */
export function openingQuantity(
  moq: Extract<Eligibility, { available: true }>['moq'],
  unitSize: number,
  pieces: number | undefined,
): number {
  if (pieces === undefined || !Number.isFinite(pieces) || pieces <= moq.minimumBaseUnits)
    return moq.quantity;
  const wanted = Math.ceil(pieces / Math.max(1, unitSize));
  const step = Math.max(1, moq.incrementQuantity);
  let quantity = moq.quantity + Math.ceil((wanted - moq.quantity) / step) * step;
  if (moq.maxQuantity !== null && quantity > moq.maxQuantity) {
    quantity = moq.quantity + Math.floor((moq.maxQuantity - moq.quantity) / step) * step;
  }
  return Math.max(moq.quantity, quantity);
}

export interface EligibilityResponse {
  eligibility: Eligibility;
  viewer: { signedIn: boolean; isBusinessBuyer: boolean; addressId: string | null };
}

export interface PreorderFormInput {
  productId: string;
  variantId: string | null;
  offerId: string | null;
  orderingUnit: PreorderUnit;
  unitQuantity: number;
  requestedDeliveryDate: string;
  shippingAddressId: string;
  destinationWarehouseLabel: string | null;
  packagingPreference: PreorderUnit | null;
  transportPreference: 'ANY' | 'ROAD' | 'AIR' | 'SEA' | 'RAIL';
  allowPartialDelivery: boolean;
  purchaseOrderReference: string | null;
  customerNotes: string | null;
  handlingInstructions: string | null;
  acceptTerms: boolean;
  displayCurrency: string | null;
}

export interface PreorderPreview {
  offerId: string;
  sellerName: string;
  baseUnits: number;
  unitsPerPackage: number;
  minimumBaseUnits: number;
  incrementBaseUnits: number;
  maximumBaseUnits: number | null;
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  currency: string;
  unitPrice: Money | null;
  goodsTotal: Money | null;
  appliedTierMinBaseUnits: number | null;
  listUnitPrice: Money;
  savingPerPiece: Money | null;
  approximate: {
    currency: string;
    rate: string;
    rateAsOf: string;
    unitPrice: Money;
    goodsTotal: Money;
  } | null;
  window: {
    earliest: string;
    latest: string | null;
    decidedBy: string;
    timezone: string;
    hasPublishedTransit: boolean;
  };
  instantStockBaseUnits: number;
}

export interface PreorderOffer {
  id: string;
  revision: number;
  author: 'BUYER' | 'SELLER';
  kind: 'ACCEPT_AS_REQUESTED' | 'COUNTER';
  state: 'PROPOSED' | 'ACCEPTED' | 'DECLINED' | 'SUPERSEDED' | 'EXPIRED' | 'WITHDRAWN';
  quantityBaseUnits: number;
  unitPrice: Money;
  goodsTotal: Money;
  freight: Money;
  total: Money;
  currency: string;
  committedDeliveryDate: string;
  deliverySplits: { date: string; baseUnits: number }[] | null;
  note: string | null;
  expiresAt: string;
  termsHash: string;
  createdByLabel: string;
  createdAt: string;
  respondedAt: string | null;
  respondedByLabel: string | null;
  responseNote: string | null;
}

export interface Preorder {
  id: string;
  requestNumber: string;
  status: PreorderStatus;
  allowedActions: PreorderStatus[];
  awaiting: 'SELLER' | 'BUYER' | null;
  product: {
    id: string;
    variantId: string | null;
    name: string;
    slug: string | null;
    sku: string;
    imageUrl: string | null;
  };
  seller: { id: string; name: string };
  buyer: { name: string; organization: string | null; taxNumber: string | null } | null;
  quantity: {
    orderingUnit: PreorderUnit;
    unitQuantity: number;
    unitsPerPackage: number;
    baseUnits: number;
  };
  policy: Record<string, unknown> & { version: number; minimumBaseUnits?: number };
  requestedDeliveryDate: string;
  earliestDeliveryDate: string;
  timezone: string;
  shippingAddress: Record<string, string | null>;
  destinationCountry: string;
  destinationWarehouseLabel: string | null;
  packagingPreference: PreorderUnit | null;
  transportPreference: string;
  allowPartialDelivery: boolean;
  purchaseOrderReference: string | null;
  customerNotes: string | null;
  handlingInstructions: string | null;
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  currency: string;
  indicative: {
    unitPrice: Money | null;
    goodsTotal: Money | null;
    tierMinBaseUnits: number | null;
    displayCurrency: string | null;
    fxRate: string | null;
    fxRateAsOf: string | null;
  };
  currentOffer: PreorderOffer | null;
  offers: PreorderOffer[];
  confirmed: {
    termsHash: string;
    baseUnits: number | null;
    unitPrice: Money | null;
    freight: Money | null;
    goodsTotal: Money | null;
    committedDeliveryDate: string | null;
  } | null;
  order: { id: string; orderNumber: string; status: string; grandTotal: Money } | null;
  /** The seller's part of that order, for Seller Hub. Null for the buyer. */
  sellerOrderGroupId: string | null;
  capacity: {
    periodKey: string;
    period: string;
    capacityBaseUnits: number;
    reservedBaseUnits: number;
    availableBaseUnits: number;
    requestedBaseUnits: number;
    fits: boolean;
  } | null;
  capacityReservedBaseUnits: number | null;
  expiresAt: string | null;
  closedReason: string | null;
  history: {
    fromStatus: PreorderStatus | null;
    toStatus: PreorderStatus;
    actorLabel: string;
    reason: string | null;
    at: string;
  }[];
  submittedAt: string;
  updatedAt: string;
  version: number;
}

export interface PreorderListItem {
  id: string;
  requestNumber: string;
  status: PreorderStatus;
  baseUnits: number;
  requestedDeliveryDate: string;
  committedDeliveryDate: string | null;
  value: Money | null;
  expiresAt: string | null;
  submittedAt: string;
  updatedAt: string;
  productName: string;
  sellerName?: string;
  buyerOrganization?: string;
}

// --- The buyer ---------------------------------------------------------------

export function eligibilityQueryKey(productId: string, variantId: string | null) {
  return ['preorder', 'eligibility', productId, variantId ?? ''] as const;
}

export function fetchEligibility(
  productId: string,
  variantId: string | null,
  addressId?: string | null,
) {
  return api.get<EligibilityResponse>('/preorders/eligibility', {
    query: {
      productId,
      ...(variantId === null ? {} : { variantId }),
      ...(addressId === undefined || addressId === null ? {} : { addressId }),
    },
  });
}

export function previewPreorder(input: PreorderFormInput) {
  return api
    .post<{ preview: PreorderPreview }>('/preorders/preview', input)
    .then((body) => body.preview);
}

export function submitPreorder(input: PreorderFormInput, idempotencyKey: string) {
  return api
    .post<{ preorder: Preorder }>('/preorders', input, { idempotencyKey })
    .then((body) => body.preorder);
}

export function fetchMyPreorders() {
  return api.get<{ preorders: PreorderListItem[] }>('/preorders').then((body) => body.preorders);
}

export function fetchMyPreorder(id: string) {
  return api.get<{ preorder: Preorder }>(`/preorders/${id}`).then((body) => body.preorder);
}

export function confirmPreorder(id: string, offer: { id: string; termsHash: string }) {
  return api
    .post<{ preorder: Preorder }>(
      `/preorders/${id}/confirm`,
      { offerId: offer.id, termsHash: offer.termsHash },
      { idempotencyKey: newIdempotencyKey() },
    )
    .then((body) => body.preorder);
}

export function declinePreorder(id: string, note: string | null) {
  return api
    .post<{ preorder: Preorder }>(`/preorders/${id}/decline`, { note })
    .then((body) => body.preorder);
}

export function cancelPreorder(id: string, reason: string) {
  return api
    .post<{ preorder: Preorder }>(`/preorders/${id}/cancel`, { reason })
    .then((body) => body.preorder);
}

// --- The seller ----------------------------------------------------------------

export const SELLER_PREORDER_FILTERS = [
  'awaiting_seller',
  'new',
  'countered',
  'awaiting_buyer',
  'confirmed',
  'in_production',
  'converted',
  'rejected',
  'expired',
  'cancelled',
] as const;

export type SellerPreorderFilter = (typeof SELLER_PREORDER_FILTERS)[number];

export function fetchSellerPreorders(filter: SellerPreorderFilter | null) {
  return api.get<{ counts: Record<string, number>; preorders: PreorderListItem[] }>(
    '/seller/preorders',
    {
      query: filter === null ? {} : { filter },
    },
  );
}

export function fetchSellerPreorder(id: string) {
  return api.get<{ preorder: Preorder }>(`/seller/preorders/${id}`).then((body) => body.preorder);
}

export function sellerAcceptPreorder(
  id: string,
  body: {
    unitPriceMinor: string | null;
    freightMinor: string;
    originLocationId: string | null;
    note: string | null;
    expectedVersion: number;
  },
) {
  return api
    .post<{ preorder: Preorder }>(`/seller/preorders/${id}/accept`, {
      ...body,
      committedDeliveryDate: null,
    })
    .then((response) => response.preorder);
}

export function sellerCounterPreorder(
  id: string,
  body: {
    quantityBaseUnits: number;
    unitPriceMinor: string;
    freightMinor: string;
    committedDeliveryDate: string;
    deliverySplits: { date: string; baseUnits: number }[] | null;
    originLocationId: string | null;
    note: string | null;
    expectedVersion: number;
  },
) {
  return api
    .post<{ preorder: Preorder }>(`/seller/preorders/${id}/counter`, body)
    .then((response) => response.preorder);
}

export function sellerRejectPreorder(id: string, reason: string, expectedVersion: number) {
  return api
    .post<{ preorder: Preorder }>(`/seller/preorders/${id}/reject`, { reason, expectedVersion })
    .then((response) => response.preorder);
}

export function sellerAdvancePreorder(
  id: string,
  step: 'start-production' | 'ready',
  note: string | null,
) {
  return api
    .post<{ preorder: Preorder }>(`/seller/preorders/${id}/${step}`, { note })
    .then((response) => response.preorder);
}

// --- The seller's terms ------------------------------------------------------------

export interface PreorderPolicy {
  id: string;
  scope: 'OFFER' | 'PRODUCT' | 'SELLER_DEFAULT';
  version: number;
  isEnabled: boolean;
  moqUnit: PreorderUnit;
  moqQuantity: number | null;
  incrementQuantity: number;
  maxQuantity: number | null;
  capacityBaseUnits: number | null;
  capacityPeriod: 'DAY' | 'WEEK' | 'MONTH';
  minLeadTimeDays: number | null;
  maxAdvanceDays: number | null;
  deliveryCountries: string[];
  eligibleLocationIds: string[];
  packagingTypes: PreorderUnit[] | null;
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  allowPartialFulfilment: boolean;
  allowSplitDelivery: boolean;
  requestExpiryHours: number | null;
  offerExpiryHours: number | null;
  cancellationTerms: string | null;
  specialInstructions: string | null;
  tiers: { minBaseUnits: number; unitPriceMinor: string; currency: string }[];
  updatedAt: string;
  updatedByLabel: string | null;
}

export interface PolicyChain {
  currency?: string;
  offer: PreorderPolicy | null;
  product: PreorderPolicy | null;
  sellerDefault: PreorderPolicy | null;
  applies: 'OFFER' | 'PRODUCT' | 'SELLER_DEFAULT' | null;
  /** Nothing configured, and buyers can still preorder on the platform's default terms. */
  platformDefault?: boolean;
  unitSizes?: Partial<Record<PreorderUnit, number>>;
  effective?: {
    rules: {
      minimumBaseUnits: number;
      incrementBaseUnits: number;
      maximumBaseUnits: number | null;
    } | null;
    issues: { field: string; message: string }[];
  } | null;
}

export type PreorderPolicyInput = Omit<
  PreorderPolicy,
  'id' | 'version' | 'updatedAt' | 'updatedByLabel' | 'tiers'
> & {
  offerId: string | null;
  tiers: { minBaseUnits: number; unitPriceMinor: string }[];
  expectedVersion: number | null;
};

export function fetchPolicyChain(offerId: string | null) {
  return api
    .get<{ chain: PolicyChain }>('/seller/preorder-policies', {
      query: offerId === null ? {} : { offerId },
    })
    .then((body) => body.chain);
}

export function savePreorderPolicy(input: PreorderPolicyInput) {
  return api
    .put<{ policy: PreorderPolicy }>('/seller/preorder-policies', input)
    .then((body) => body.policy);
}

export function deletePreorderPolicy(id: string) {
  return api.delete<undefined>(`/seller/preorder-policies/${id}`);
}

/** Statuses a person reading the list is waiting on somebody for. */
export function preorderTone(
  status: PreorderStatus,
): 'neutral' | 'brand' | 'action' | 'operational' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'SUBMITTED':
    case 'SELLER_REVIEW_REQUIRED':
      return 'action';
    case 'SELLER_ACCEPTED':
    case 'SELLER_COUNTERED':
    case 'PAYMENT_REQUIRED':
      return 'warning';
    case 'CONFIRMED':
    case 'IN_PRODUCTION':
    case 'READY_FOR_FULFILLMENT':
      return 'operational';
    case 'CONVERTED_TO_ORDER':
      return 'success';
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'danger';
    default:
      return 'neutral';
  }
}
