/**
 * Seller Hub -> Logistics, as the browser sees it: the four-level policy, the
 * carriers, the level prices, the legs of confirmed orders and the read-only
 * settlement preview.
 *
 * Every figure is minor units as a string, exactly as the API sends it, and
 * nothing here adds money up: the delivery total, the fee and the settlement
 * all come from the server, so the Hub and the checkout cannot disagree with
 * what a buyer is charged.
 */
import { api } from './api';
import type { Money } from './format';

export type LogisticsLevel = 'L1' | 'L2' | 'L3' | 'L4';
export type ControlMode = 'SELF' | 'UBOSS' | 'HYBRID';
export type ControlOwner = 'SELLER' | 'UBOSS';
export type TransportMode = 'ROAD' | 'AIR' | 'SEA' | 'RAIL' | 'POSTAL';
export type ManagedProvider = 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL';
export type ProviderConnectionState =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_REQUIRED'
  | 'MANUAL_ONLY'
  | 'PENDING_VERIFICATION'
  | 'CONNECTED'
  | 'CONNECTION_FAILED';
export type LevelPricingStatus =
  | 'DRAFT'
  | 'PRICE_REQUIRED'
  | 'QUOTE_REQUIRED'
  | 'PENDING_UBOSS_PRICE'
  | 'READY'
  | 'PUBLISHED'
  | 'INACTIVE';

export const LEVELS: readonly LogisticsLevel[] = ['L1', 'L2', 'L3', 'L4'];
export const SWITCHABLE_LEVELS: readonly LogisticsLevel[] = ['L2', 'L3', 'L4'];
export const MANAGED_PROVIDERS: readonly ManagedProvider[] = ['DHL', 'FEDEX', 'INDIA_POST', 'MANUAL'];

export type LevelOwners = Record<LogisticsLevel, ControlOwner>;

export interface ProviderView {
  provider: ManagedProvider;
  enabled: boolean;
  requestedMode: 'MANUAL_ONLY' | 'API' | null;
  connectionState: ProviderConnectionState;
  hasVerifiedApi: boolean;
  transportModes: TransportMode[];
}

export interface RateView {
  id: string;
  level: LogisticsLevel;
  owner: ControlOwner;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'INACTIVE';
  versionNumber: number;
  supersedesRateId: string | null;
  originLocationId: string | null;
  originLocationName: string | null;
  originPortCode: string | null;
  destinationPortCode: string | null;
  destinationHubCode: string | null;
  destinationHubName: string | null;
  destinationCountry: string | null;
  destinationPostalPrefix: string;
  packageClass: string | null;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
  isWorldwideFlat: boolean;
  transportMode: TransportMode;
  provider: ManagedProvider | null;
  logisticsPartnerId: string | null;
  logisticsPartnerName: string | null;
  providerLabel: string | null;
  serviceName: string | null;
  trackingReferenceKind: string | null;
  requiresCustomsRelease: boolean;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  /** Null when nobody has priced it. Never zero unless `isFree`. */
  price: Money | null;
  currency: string;
  isFree: boolean;
  taxInclusive: boolean;
  priceSource: string;
  effectiveFrom: string;
  isComplete: boolean;
  updatedBy: { role: ControlOwner; label: string | null };
  updatedAt: string;
  publishedAt: string | null;
}

export interface LevelView {
  level: LogisticsLevel;
  sequence: number;
  owner: ControlOwner;
  activeOwner: ControlOwner | null;
  editableBySeller: boolean;
  pricingStatus: LevelPricingStatus;
  transportModes: TransportMode[];
  rates: RateView[];
  warnings: string[];
}

export interface PolicyView {
  sellerAccountId: string;
  sellerName: string;
  settlementCurrency: string;
  draft: { mode: ControlMode; owners: LevelOwners; version: number; updatedAt: string | null };
  active: {
    versionId: string;
    versionNumber: number;
    mode: ControlMode;
    owners: LevelOwners;
    publishedAt: string;
  } | null;
  hasUnpublishedChanges: boolean;
  levels: LevelView[];
  providers: ProviderView[];
  routesCanBeOffered: boolean;
  locations: { id: string; name: string; code: string; countryCode: string }[];
}

export interface RateInput {
  level: LogisticsLevel;
  originLocationId?: string | null;
  originPortCode?: string | null;
  destinationPortCode?: string | null;
  destinationHubCode?: string | null;
  destinationHubName?: string | null;
  destinationCountry?: string | null;
  destinationPostalPrefix?: string | null;
  packageClass?: 'PARCEL' | 'PALLET' | 'CONTAINER' | null;
  isWorldwideFlat?: boolean;
  transportMode: TransportMode;
  provider?: ManagedProvider | null;
  logisticsPartnerId?: string | null;
  providerLabel?: string | null;
  serviceName?: string | null;
  trackingReferenceKind?: 'AWB' | 'BOL' | 'CONTAINER' | 'TRACKING' | null;
  requiresCustomsRelease?: boolean;
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  amountMinor?: string | null;
  currency?: string | null;
  isFree?: boolean;
  confirmFree?: boolean;
  taxInclusive?: boolean;
  effectiveFrom?: string | null;
}

export const policyKey = ['seller', 'logistics', 'policy'] as const;

export function fetchPolicy(): Promise<{ policy: PolicyView }> {
  return api.get<{ policy: PolicyView }>('/seller/logistics/policy');
}

export function savePolicy(input: {
  mode: ControlMode;
  l2Owner?: ControlOwner;
  l3Owner?: ControlOwner;
  l4Owner?: ControlOwner;
  expectedVersion?: number;
  confirmOwnershipChange?: boolean;
}): Promise<{ policy: PolicyView }> {
  return api.put<{ policy: PolicyView }>('/seller/logistics/policy', input);
}

export function publishPolicy(input: {
  confirmOwnershipChange?: boolean;
  changeNote?: string | null;
}): Promise<{ policy: PolicyView }> {
  return api.post<{ policy: PolicyView }>('/seller/logistics/policy/publish', input);
}

export function enableProvider(provider: ManagedProvider, connectionMode: 'MANUAL_ONLY' | 'API'): Promise<{ provider: ProviderView }> {
  return api.post<{ provider: ProviderView }>(`/seller/logistics/providers/${provider}/enable`, { connectionMode });
}

export function disableProvider(provider: ManagedProvider): Promise<{ provider: ProviderView }> {
  return api.post<{ provider: ProviderView }>(`/seller/logistics/providers/${provider}/disable`, {});
}

export function fetchLogisticsPartners(): Promise<{
  partners: { id: string; displayName: string; partnerKind: string }[];
}> {
  return api.get('/seller/logistics/partners');
}

export function createRate(input: RateInput): Promise<{ rate: RateView }> {
  return api.post<{ rate: RateView }>('/seller/logistics/rates', input);
}

export function updateRate(rateId: string, input: RateInput): Promise<{ rate: RateView }> {
  return api.put<{ rate: RateView }>(`/seller/logistics/rates/${rateId}`, input);
}

export function publishRate(rateId: string): Promise<{ rate: RateView }> {
  return api.post<{ rate: RateView }>(`/seller/logistics/rates/${rateId}/publish`, {});
}

export function deactivateRate(rateId: string): Promise<{ rate: RateView }> {
  return api.post<{ rate: RateView }>(`/seller/logistics/rates/${rateId}/deactivate`, {});
}

// --- Legs --------------------------------------------------------------------

export type LegStatus =
  | 'PENDING'
  | 'AWAITING_ASSIGNMENT'
  | 'ASSIGNED'
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED';

export interface LegView {
  id: string;
  level: LogisticsLevel;
  sequence: number;
  owner: ControlOwner;
  status: LegStatus;
  carrier: string | null;
  provider: ManagedProvider | null;
  trackingNumber: string | null;
  trackingReferenceKind: string | null;
  expectedStartAt: string | null;
  expectedCompleteAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  origin: string | null;
  destination: string | null;
  transportMode: TransportMode | null;
  version: number;
  logisticsPartnerId: string | null;
  serviceName: string | null;
  connectionMode: 'MANUAL_ONLY' | 'API' | null;
  pickupReference: string | null;
  hasDriver: boolean;
  assignedByRole: string | null;
  charge: {
    amount: Money;
    original: Money;
    isFree: boolean;
    pricedWith: string | null;
    transitDaysMin: number | null;
    transitDaysMax: number | null;
  } | null;
  events: {
    id: string;
    kind: string;
    fromStatus: LegStatus | null;
    toStatus: LegStatus;
    actorRole: string;
    note: string | null;
    occurredAt: string;
  }[];
  editableBySeller: boolean;
}

export const legsKey = (sellerOrderId: string) => ['seller', 'orders', sellerOrderId, 'legs'] as const;

export function fetchLegs(sellerOrderId: string): Promise<{ legs: LegView[] }> {
  return api.get<{ legs: LegView[] }>(`/seller/orders/${sellerOrderId}/legs`);
}

export function assignLeg(
  sellerOrderId: string,
  level: LogisticsLevel,
  input: {
    provider?: ManagedProvider | null;
    logisticsPartnerId?: string | null;
    providerLabel?: string | null;
    trackingNumber?: string | null;
    reason?: string | null;
    expectedVersion?: number;
  },
): Promise<{ legs: LegView[] }> {
  return api.post<{ legs: LegView[] }>(`/seller/orders/${sellerOrderId}/legs/${level}/assign`, input);
}

export function updateLegReferences(
  sellerOrderId: string,
  level: LogisticsLevel,
  input: { trackingNumber?: string | null; pickupReference?: string | null },
): Promise<{ legs: LegView[] }> {
  return api.patch<{ legs: LegView[] }>(`/seller/orders/${sellerOrderId}/legs/${level}`, input);
}

export function moveLeg(
  sellerOrderId: string,
  level: LogisticsLevel,
  input: { to: 'AWAITING_ASSIGNMENT' | 'IN_PROGRESS' | 'COMPLETED'; note?: string | null; idempotencyKey?: string },
): Promise<{ legs: LegView[] }> {
  return api.post<{ legs: LegView[] }>(`/seller/orders/${sellerOrderId}/legs/${level}/transition`, input);
}

// --- Settlement (read-only) --------------------------------------------------------

export interface SettlementEstimate {
  currency: string;
  grossProceeds: Money;
  sellerDeliveryProceeds: Money;
  ubossDelivery: Money;
  feeBasis: Money;
  platformFee: Money;
  platformFeeTax: Money;
  refundsAdjustments: Money;
  estimatedSettlement: Money;
  feeTaxLabel: string;
  feeTaxVerified: boolean;
  feeTaxRatePercent: string;
  policy: { name: string; versionNumber: number; percentRate: string; feeType: string } | null;
}

export function fetchSettlementEstimate(input: {
  goodsMinor: string;
  sellerDeliveryMinor: string;
  currency?: string;
}): Promise<{ estimate: SettlementEstimate }> {
  const query = new URLSearchParams({
    goodsMinor: input.goodsMinor,
    sellerDeliveryMinor: input.sellerDeliveryMinor,
    ...(input.currency === undefined ? {} : { currency: input.currency }),
  });
  return api.get<{ estimate: SettlementEstimate }>(`/seller/settlements/estimate?${query.toString()}`);
}
