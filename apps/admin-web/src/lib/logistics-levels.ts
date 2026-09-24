/**
 * The marketplace's side of the four delivery levels and the platform fee.
 *
 * Money is minor units as strings from the server; nothing here adds it up.
 */
import { api } from './api';
import type { Money } from './format';

export type LogisticsLevel = 'L1' | 'L2' | 'L3' | 'L4';
export type ControlMode = 'SELF' | 'UBOSS' | 'HYBRID';
export type ControlOwner = 'SELLER' | 'UBOSS';
export type TransportMode = 'ROAD' | 'AIR' | 'SEA' | 'RAIL' | 'POSTAL';
export type LevelOwners = Record<LogisticsLevel, ControlOwner>;

export const LEVELS: readonly LogisticsLevel[] = ['L1', 'L2', 'L3', 'L4'];
export const LEVEL_MODES: Record<LogisticsLevel, TransportMode[]> = {
  L1: ['ROAD', 'RAIL'],
  L2: ['AIR', 'SEA', 'ROAD', 'RAIL', 'POSTAL'],
  L3: ['ROAD', 'RAIL'],
  L4: ['ROAD', 'POSTAL'],
};

export interface ManagedLevelRow {
  sellerAccountId: string;
  sellerName: string;
  mode: ControlMode | null;
  versionNumber: number | null;
  owners: LevelOwners | null;
  levels: { level: LogisticsLevel; owner: ControlOwner; hasPublishedPrice: boolean }[];
  missingUbossPrices: number;
  missingSellerPrices: number;
}

export interface RateView {
  id: string;
  level: LogisticsLevel;
  owner: ControlOwner;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'INACTIVE';
  versionNumber: number;
  originLocationName: string | null;
  originPortCode: string | null;
  destinationPortCode: string | null;
  destinationHubCode: string | null;
  destinationHubName: string | null;
  destinationCountry: string | null;
  destinationPostalPrefix: string;
  isWorldwideFlat: boolean;
  transportMode: TransportMode;
  provider: string | null;
  logisticsPartnerId: string | null;
  logisticsPartnerName: string | null;
  providerLabel: string | null;
  serviceName: string | null;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
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
  owner: ControlOwner;
  activeOwner: ControlOwner | null;
  pricingStatus: string;
  rates: RateView[];
  warnings: string[];
}

export interface PolicyView {
  sellerAccountId: string;
  sellerName: string;
  settlementCurrency: string;
  draft: { mode: ControlMode; owners: LevelOwners; version: number };
  active: { versionNumber: number; mode: ControlMode; owners: LevelOwners; publishedAt: string } | null;
  levels: LevelView[];
  providers: { provider: string; enabled: boolean; connectionState: string }[];
  routesCanBeOffered: boolean;
}

export interface PolicyHistory {
  versions: { id: string; versionNumber: number; mode: ControlMode; owners: LevelOwners; publishedAt: string; supersededAt: string | null }[];
  events: { id: string; action: string; actorType: string; actorLabel: string | null; summary: string | null; createdAt: string }[];
}

export function fetchManagedLevels(params: { ubossOnly?: boolean; missingOnly?: boolean; search?: string }): Promise<{ sellers: ManagedLevelRow[] }> {
  const query = new URLSearchParams();
  if (params.ubossOnly === true) query.set('ubossOnly', 'true');
  if (params.missingOnly === true) query.set('missingOnly', 'true');
  if (params.search !== undefined && params.search !== '') query.set('search', params.search);
  return api.get(`/admin/logistics/managed-levels?${query.toString()}`);
}

export function fetchManagedSeller(sellerAccountId: string): Promise<{
  policy: PolicyView;
  history: PolicyHistory;
  marketplaceCarriers: { id: string; displayName: string }[];
}> {
  return api.get(`/admin/logistics/managed-levels/sellers/${sellerAccountId}`);
}

export interface UbossRateInput {
  level: LogisticsLevel;
  originPortCode?: string | null;
  destinationPortCode?: string | null;
  destinationHubCode?: string | null;
  destinationHubName?: string | null;
  destinationCountry?: string | null;
  destinationPostalPrefix?: string | null;
  isWorldwideFlat?: boolean;
  transportMode: TransportMode;
  provider?: 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL' | null;
  logisticsPartnerId?: string | null;
  providerLabel?: string | null;
  serviceName?: string | null;
  transitDaysMin?: number | null;
  transitDaysMax?: number | null;
  amountMinor?: string | null;
  currency?: string | null;
  isFree?: boolean;
  confirmFree?: boolean;
  taxInclusive?: boolean;
}

export function createUbossRate(sellerAccountId: string, input: UbossRateInput): Promise<{ rate: RateView }> {
  return api.post(`/admin/logistics/managed-levels/sellers/${sellerAccountId}/rates`, input);
}

export function updateUbossRate(rateId: string, input: UbossRateInput): Promise<{ rate: RateView }> {
  return api.put(`/admin/logistics/managed-levels/rates/${rateId}`, input);
}

export function publishUbossRate(rateId: string): Promise<{ rate: RateView }> {
  return api.post(`/admin/logistics/managed-levels/rates/${rateId}/publish-price`, {});
}

export function deactivateUbossRate(rateId: string): Promise<{ rate: RateView }> {
  return api.post(`/admin/logistics/managed-levels/rates/${rateId}/deactivate`, {});
}

export function fetchPresentation(): Promise<{ showLevelBreakdown: boolean }> {
  return api.get('/admin/logistics/presentation');
}

export function savePresentation(showLevelBreakdown: boolean): Promise<{ showLevelBreakdown: boolean }> {
  return api.put('/admin/logistics/presentation', { showLevelBreakdown });
}

// --- Legs --------------------------------------------------------------------

export type LegStatus = 'PENDING' | 'AWAITING_ASSIGNMENT' | 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface LegView {
  id: string;
  level: LogisticsLevel;
  sequence: number;
  owner: ControlOwner;
  status: LegStatus;
  carrier: string | null;
  provider: string | null;
  trackingNumber: string | null;
  origin: string | null;
  destination: string | null;
  transportMode: TransportMode | null;
  version: number;
  orderId: string;
  orderNumber: string;
  sellerOrderNumber: string;
  sellerName: string;
  logisticsPartnerId: string | null;
  hasDriver: boolean;
  assignedByRole: string | null;
  charge: { amount: Money; isFree: boolean; pricedWith: string | null } | null;
  events: { id: string; kind: string; fromStatus: LegStatus | null; toStatus: LegStatus; actorRole: string; note: string | null; occurredAt: string }[];
  completedAt: string | null;
}

export function fetchLegs(params: { owner?: ControlOwner | ''; status?: LegStatus | ''; needsAssignment?: boolean }): Promise<{ legs: LegView[] }> {
  const query = new URLSearchParams();
  if (params.owner !== undefined && params.owner !== '') query.set('owner', params.owner);
  if (params.status !== undefined && params.status !== '') query.set('status', params.status);
  if (params.needsAssignment === true) query.set('needsAssignment', 'true');
  return api.get(`/admin/logistics/legs?${query.toString()}`);
}

export function fetchLeg(legId: string): Promise<{
  leg: LegView;
  journey: LegView[];
  marketplaceCarriers: { id: string; displayName: string }[];
}> {
  return api.get(`/admin/logistics/legs/${legId}`);
}

export function assignUbossLeg(
  legId: string,
  input: { provider?: string | null; logisticsPartnerId?: string | null; providerLabel?: string | null; trackingNumber?: string | null; reason?: string | null; expectedVersion?: number },
) {
  return api.post<{ leg: LegView }>(`/admin/logistics/legs/${legId}/assign`, input);
}

export function updateUbossLegReferences(legId: string, input: { trackingNumber?: string | null; pickupReference?: string | null }) {
  return api.patch<{ leg: LegView }>(`/admin/logistics/legs/${legId}`, input);
}

export function moveUbossLeg(legId: string, input: { to: 'AWAITING_ASSIGNMENT' | 'IN_PROGRESS' | 'COMPLETED'; note?: string | null; idempotencyKey?: string }) {
  return api.post<{ leg: LegView }>(`/admin/logistics/legs/${legId}/transition`, input);
}

// --- Platform fee --------------------------------------------------------------

export interface FeePolicyView {
  id: string;
  scope: 'GLOBAL' | 'MARKET' | 'CATEGORY' | 'SELLER';
  scopeKey: string;
  sellerAccountId: string | null;
  categoryId: string | null;
  marketCountry: string | null;
  versionNumber: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  name: string;
  feeType: 'PERCENT' | 'FLAT' | 'PERCENT_PLUS_FLAT';
  feeBasis: 'PRODUCT_SUBTOTAL' | 'PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY';
  percentRate: string;
  flatFee: Money;
  minFee: Money | null;
  maxFee: Money | null;
  currency: string;
  taxRatePercent: string;
  taxLabel: string;
  taxDisplayLabel: string;
  isTaxRuleVerified: boolean;
  taxVerifiedAt: string | null;
  taxVerificationNote: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  publishedAt: string | null;
  settlementCount: number;
}

export interface FeePolicyInput {
  scope: FeePolicyView['scope'];
  sellerAccountId?: string | null;
  categoryId?: string | null;
  marketCountry?: string | null;
  name: string;
  feeType: FeePolicyView['feeType'];
  feeBasis: FeePolicyView['feeBasis'];
  percentRate: string;
  flatFeeMinor?: string | null;
  minFeeMinor?: string | null;
  maxFeeMinor?: string | null;
  currency?: string | null;
  taxRatePercent: string;
  taxLabel?: string | null;
  effectiveFrom?: string | null;
  notes?: string | null;
}

export function fetchFeePolicies(): Promise<{ policies: FeePolicyView[] }> {
  return api.get('/admin/platform-fees');
}

export function createFeePolicy(input: FeePolicyInput): Promise<{ policy: FeePolicyView }> {
  return api.post('/admin/platform-fees', input);
}

export function publishFeePolicy(policyId: string): Promise<{ policy: FeePolicyView }> {
  return api.post(`/admin/platform-fees/${policyId}/publish`, {});
}

export function retireFeePolicy(policyId: string): Promise<{ policy: FeePolicyView }> {
  return api.post(`/admin/platform-fees/${policyId}/retire`, {});
}

export function verifyFeeTax(policyId: string, note: string): Promise<{ policy: FeePolicyView }> {
  return api.post(`/admin/platform-fees/${policyId}/verify-tax`, { note });
}

export function fetchFeePolicyOrders(policyId: string): Promise<{
  orders: { sellerOrderGroupId: string; sellerOrderNumber: string; orderNumber: string; sellerName: string; platformFee: Money; platformFeeTax: Money; computedAt: string }[];
}> {
  return api.get(`/admin/platform-fees/${policyId}/orders`);
}

export function previewFee(input: { sellerAccountId: string; goodsMinor: string; sellerDeliveryMinor: string; currency?: string }): Promise<{
  estimate: {
    grossProceeds: Money;
    sellerDeliveryProceeds: Money;
    platformFee: Money;
    platformFeeTax: Money;
    estimatedSettlement: Money;
    feeTaxLabel: string;
  };
}> {
  return api.post('/admin/platform-fees/preview', input);
}
