/**
 * Fee rules - the console's client for Finance -> Fee rules.
 *
 * Value bands, volume tiers, seller tiers and promotions that sit on top of the
 * platform-fee policy. Every rule is drafted by one person and approved by
 * another; the server enforces that, and `isIndependentOf` is only so the
 * screen does not offer an approval it knows will be refused.
 */
import { api } from './api';
import type { Money } from './format';

export const FEE_RULE_KINDS = ['VALUE_BAND', 'VOLUME_TIER', 'SELLER_TIER', 'PROMOTION'] as const;
export type FeeRuleKind = (typeof FEE_RULE_KINDS)[number];

export const FEE_RULE_SCOPES = ['GLOBAL', 'MARKET', 'CATEGORY', 'SELLER'] as const;
export type FeeRuleScope = (typeof FEE_RULE_SCOPES)[number];

export const FEE_RULE_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'RETIRED'] as const;
export type FeeRuleStatus = (typeof FEE_RULE_STATUSES)[number];

export interface FeeRuleView {
  id: string;
  kind: FeeRuleKind;
  scope: FeeRuleScope;
  scopeKey: string;
  sellerAccountId: string | null;
  categoryId: string | null;
  marketCountry: string | null;
  status: FeeRuleStatus;
  name: string;
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
  notes: string | null;
  supersedesRuleId: string | null;
  createdByUserId: string | null;
  lastEditedByUserId: string | null;
  submittedByUserId: string | null;
  submittedAt: string | null;
  publishedByUserId: string | null;
  publishedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  retiredAt: string | null;
  createdAt: string;
  settlementCount: number;
}

/** What the create and edit routes accept. Money is whole minor units, as text. */
export interface FeeRuleInput {
  kind: FeeRuleKind;
  scope: FeeRuleScope;
  sellerAccountId?: string | null;
  categoryId?: string | null;
  marketCountry?: string | null;
  name: string;
  currency?: string | null;
  minValueMinor?: string | null;
  maxValueMinor?: string | null;
  volumeThresholdMinor?: string | null;
  volumeWindowDays?: number | null;
  sellerTier?: string | null;
  percentRate?: string | null;
  discountPercent?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  supersedesRuleId?: string | null;
}

export interface FeeRuleOrders {
  rule: Omit<FeeRuleView, 'settlementCount'>;
  orders: {
    sellerOrderGroupId: string;
    sellerOrderNumber: string;
    orderNumber: string;
    sellerName: string;
    effect: Money;
    effectIsSaving: boolean;
    platformFee: Money;
    computedAt: string;
  }[];
}

/**
 * Whether this person may approve the rule. False for whoever created, last
 * edited or submitted it: the server refuses those with
 * `PLATFORM_FEE_SELF_APPROVAL_FORBIDDEN`.
 */
export function isIndependentOf(rule: FeeRuleView, userId: string | undefined): boolean {
  if (userId === undefined) return false;
  return ![rule.createdByUserId, rule.lastEditedByUserId, rule.submittedByUserId].includes(userId);
}

export function fetchFeeRules(status?: FeeRuleStatus): Promise<{ rules: FeeRuleView[] }> {
  return api.get(`/admin/platform-fee-rules${status === undefined ? '' : `?status=${status}`}`);
}

export function createFeeRule(input: FeeRuleInput): Promise<{ rule: FeeRuleView }> {
  return api.post('/admin/platform-fee-rules', input);
}

export function updateFeeRule(id: string, input: FeeRuleInput): Promise<{ rule: FeeRuleView }> {
  return api.put(`/admin/platform-fee-rules/${id}`, input);
}

export function submitFeeRule(id: string): Promise<{ rule: FeeRuleView }> {
  return api.post(`/admin/platform-fee-rules/${id}/submit`, {});
}

export function approveFeeRule(id: string): Promise<{ rule: FeeRuleView }> {
  return api.post(`/admin/platform-fee-rules/${id}/approve`, {});
}

export function rejectFeeRule(id: string, reason: string): Promise<{ rule: FeeRuleView }> {
  return api.post(`/admin/platform-fee-rules/${id}/reject`, { reason });
}

export function retireFeeRule(id: string): Promise<{ rule: FeeRuleView }> {
  return api.post(`/admin/platform-fee-rules/${id}/retire`, {});
}

export function fetchFeeRuleOrders(id: string): Promise<FeeRuleOrders> {
  return api.get(`/admin/platform-fee-rules/${id}/orders`);
}

/** A seller and the fee tier they are in (null: none). */
export interface SellerFeeTier {
  sellerAccountId: string;
  displayName: string;
  feeTier: string | null;
}

/** Sellers in a tier; with a search of two characters or more, the sellers matching it. */
export function fetchSellerFeeTiers(search?: string): Promise<{ sellers: SellerFeeTier[] }> {
  const q = (search ?? '').trim();
  return api.get(`/admin/seller-fee-tiers${q.length >= 2 ? `?q=${encodeURIComponent(q)}` : ''}`);
}

/** Put a seller in a tier, or take them out of one (null). Needs a reason; only their next orders change. */
export function setSellerFeeTier(sellerAccountId: string, tier: string | null, reason: string): Promise<SellerFeeTier> {
  return api.put(`/admin/seller-fee-tiers/${sellerAccountId}`, { tier, reason });
}
