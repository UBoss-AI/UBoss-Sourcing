/**
 * Held funds (D13 facilitator model): the buyer's view of how a payment is
 * protected, and the seller's balances and held funds in Seller Hub.
 * Money is minor units as strings, formatted with `formatMinor`.
 */
import { api } from './api';
import type { Money } from './format';

export type FundsStatus = 'NOT_ALLOCATED' | 'HELD' | 'ON_HOLD' | 'RELEASED';
export type ReleaseConditionKey = 'DELIVERED' | 'ACCEPTANCE_WINDOW' | 'NO_OPEN_DISPUTE' | 'INSPECTION_PASSED';

export interface ReleaseCondition {
  key: ReleaseConditionKey;
  met: boolean;
  at: string | null;
}

export interface ReleaseTerms {
  requiresDelivery: boolean;
  releaseAfterDays: number;
  disputeBlocksRelease: boolean;
  inspectionRequired: boolean;
  reserveBps: number;
  reserveDays: number;
}

export interface PaymentProtection {
  orderId: string;
  orderNumber: string;
  currency: string;
  grandTotalMinor: string;
  paidMinor: string;
  refundedMinor: string;
  payment: {
    status: string;
    method: string | null;
    provider: string;
    currency: string;
    cardBrand: string | null;
    cardLast4: string | null;
    capturedAt: string | null;
  } | null;
  protectionEnabled: boolean;
  releaseTerms: ReleaseTerms;
  sellers: {
    sellerOrderNumber: string;
    sellerName: string;
    orderStatus: string;
    fundsStatus: FundsStatus;
    onHoldForDispute: boolean;
    conditions: ReleaseCondition[];
    releasedAt: string | null;
  }[];
}

export function fetchPaymentProtection(orderId: string): Promise<PaymentProtection> {
  return api.get<PaymentProtection>(`/orders/${orderId}/payment-protection`);
}

export interface SellerBalance {
  currency: string;
  grossSalesMinor: string;
  platformFeesMinor: string;
  platformFeeTaxMinor: string;
  refundsChargedMinor: string;
  heldMinor: string;
  reserveMinor: string;
  availableMinor: string;
  inTransitMinor: string;
  paidOutMinor: string;
}

export interface SellerFinance {
  enabled: boolean;
  releaseTerms: ReleaseTerms;
  balances: SellerBalance[];
  lastReconciledAt: string | null;
}

export function fetchSellerFinance(): Promise<SellerFinance> {
  return api.get<SellerFinance>('/seller/finance/balances');
}

export interface SellerHold {
  id: string;
  sellerOrderGroupId: string;
  sellerOrderNumber: string | null;
  currency: string;
  status: Exclude<FundsStatus, 'NOT_ALLOCATED'>;
  allocatedMinor: string;
  releasedMinor: string;
  reserveMinor: string;
  conditions: ReleaseCondition[];
  holdCode: 'DISPUTE' | 'MANUAL' | null;
  holdReason: string | null;
  releasedAt: string | null;
  reserveReleaseAt: string | null;
  payout: { reference: string; status: string } | null;
}

export function fetchSellerHolds(): Promise<{ items: SellerHold[]; total: number }> {
  return api.get<{ items: SellerHold[]; total: number }>('/seller/finance/holds?pageSize=50');
}

export function conditionKey(key: ReleaseConditionKey) {
  return ({
    DELIVERED: 'finance.condition.delivered',
    ACCEPTANCE_WINDOW: 'finance.condition.acceptanceWindow',
    NO_OPEN_DISPUTE: 'finance.condition.noOpenDispute',
    INSPECTION_PASSED: 'finance.condition.inspectionPassed',
  } as const)[key];
}

export function fundsStatusKey(status: FundsStatus) {
  return ({
    NOT_ALLOCATED: 'finance.funds.notAllocated',
    HELD: 'finance.funds.held',
    ON_HOLD: 'finance.funds.onHold',
    RELEASED: 'finance.funds.released',
  } as const)[status];
}

export function fundsTone(status: FundsStatus): 'neutral' | 'brand' | 'success' | 'warning' {
  return status === 'RELEASED' ? 'success' : status === 'ON_HOLD' ? 'warning' : status === 'HELD' ? 'brand' : 'neutral';
}

/** A published fee rule that can change this seller's fee, live now or starting later. */
export interface SellerFeeRule {
  id: string;
  kind: 'VALUE_BAND' | 'VOLUME_TIER' | 'SELLER_TIER' | 'PROMOTION';
  scope: 'GLOBAL' | 'MARKET' | 'CATEGORY' | 'SELLER';
  name: string;
  marketCountry: string | null;
  categoryName: string | null;
  currency: string | null;
  minValue: Money | null;
  maxValue: Money | null;
  volumeThreshold: Money | null;
  volumeWindowDays: number | null;
  sellerTier: string | null;
  percentRate: string | null;
  discountPercent: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  upcoming: boolean;
}

export function fetchSellerFeeRules(): Promise<{ feeTier: string | null; rules: SellerFeeRule[] }> {
  return api.get('/seller/finance/fee-rules');
}
