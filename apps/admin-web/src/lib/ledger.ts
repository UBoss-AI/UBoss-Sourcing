/**
 * Finance -> Ledger: the transaction ledger per order, held funds, refunds and
 * chargebacks with their accounting status, payouts and reconciliation.
 * Money is minor units as strings; `money()` adapts it for `formatMoney`.
 */
import { api } from './api';
import type { Money } from './format';

export function money(minor: string, currency: string): Money {
  return { minor, currency, formatted: minor };
}

export interface LedgerOrderRow {
  orderId: string;
  orderNumber: string | null;
  lastActivityAt: string | null;
  settlement: 'NONE' | 'HELD' | 'ON_HOLD' | 'PARTLY_RELEASED' | 'RELEASED';
  currency: string;
  grossMinor: string;
  platformFeeMinor: string;
  platformFeeTaxMinor: string;
  sellerShareMinor: string;
  refundsMinor: string;
  refundsChargedToSellersMinor: string;
  releasedMinor: string;
  heldMinor: string;
  chargebackLossMinor: string;
  /** Tax the buyer paid on top of the price. */
  orderTaxMinor: string;
  /** Delivery for levels the operator controls, and its own shipping charge. */
  logisticsMinor: string;
  /** Discounts on marketplace lines, carried by the platform. */
  discountsFundedMinor: string;
  /** The operator's own goods, sold with no seller. */
  operatorSalesMinor: string;
  /** Buyer money received and not yet given a home. */
  unallocatedMinor: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function fetchLedgerOrders(page: number): Promise<Paged<LedgerOrderRow>> {
  return api.get<Paged<LedgerOrderRow>>(`/admin/finance/ledger/orders?page=${String(page)}&pageSize=25`);
}

export interface LedgerEntry {
  id: string;
  kind: string;
  currency: string;
  memo: string;
  actorLabel: string;
  occurredAt: string;
  providerReference: string | null;
  reversesEntryId: string | null;
  lines: { account: string; owner: string; amountMinor: string }[];
}

export interface ReleaseCondition {
  key: string;
  met: boolean;
  at: string | null;
}

export interface FundHold {
  id: string;
  orderId: string;
  sellerOrderNumber: string | null;
  sellerName: string | null;
  currency: string;
  status: 'HELD' | 'ON_HOLD' | 'RELEASED';
  allocatedMinor: string;
  releasedMinor: string;
  reserveMinor: string;
  conditions: ReleaseCondition[];
  holdCode: 'DISPUTE' | 'MANUAL' | null;
  holdReason: string | null;
  releaseKind: string | null;
  releasedAt: string | null;
  pendingRelease?: { id: string; reason: string; requestedById: string; requestedByLabel: string; requestedAt: string } | null;
}

export interface OrderLedger {
  orderId: string;
  orderNumber: string;
  currency: string;
  summary: Omit<LedgerOrderRow, 'orderId' | 'orderNumber' | 'lastActivityAt' | 'settlement'>;
  entries: LedgerEntry[];
  holds: (FundHold & { payout: { reference: string; status: string; providerPayoutId: string | null } | null })[];
  refunds: { id: string; amountMinor: string; currency: string; status: string; reason: string; accounting: string }[];
  chargebacks: { id: string; reference: string; status: string; disputedAmountMinor: string; currency: string; evidenceDueAt: string | null; accounting: string }[];
  /** No inspection money moves through the ledger; agency invoices are paid outside it. */
  inspection: {
    ledgerMinor: string;
    invoices: { id: string; invoiceNumber: string; amountMinor: string; currency: string; payer: string; status: string }[];
  };
}

export function fetchOrderLedger(orderId: string): Promise<OrderLedger> {
  return api.get<OrderLedger>(`/admin/finance/ledger/orders/${orderId}`);
}

export function fetchHolds(status: string): Promise<Paged<FundHold>> {
  const filter = status === '' ? '' : `&status=${status}`;
  return api.get<Paged<FundHold>>(`/admin/finance/holds?pageSize=50${filter}`);
}

export const suspendHold = (id: string, reason: string): Promise<void> =>
  api.post<undefined>(`/admin/finance/holds/${id}/suspend`, { reason });
export const resumeHold = (id: string): Promise<void> => api.post<undefined>(`/admin/finance/holds/${id}/resume`, {});
export const requestRelease = (id: string, reason: string): Promise<{ id: string }> =>
  api.post<{ id: string }>(`/admin/finance/holds/${id}/release`, { reason });
export const decideRelease = (id: string, approve: boolean): Promise<void> =>
  api.post<undefined>(`/admin/finance/release-requests/${id}/decide`, { approve, note: null });

export interface RefundsChargebacks {
  refunds: { id: string; orderId: string; orderNumber: string; amountMinor: string; currency: string; status: string; reason: string; createdAt: string; accounting: string }[];
  chargebacks: { id: string; reference: string; orderId: string; status: string; disputedAmountMinor: string; currency: string; evidenceDueAt: string | null; createdAt: string; accounting: string }[];
}

export function fetchRefundsChargebacks(): Promise<RefundsChargebacks> {
  return api.get<RefundsChargebacks>('/admin/finance/refunds-chargebacks?pageSize=50');
}

export interface ReconciliationRun {
  id: string;
  provider: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  matchedCount: number;
  mismatchCount: number;
  startedByLabel: string;
  startedAt: string;
  items?: { id: string; kind: string; providerReference: string | null; providerAmountMinor: string | null; ledgerAmountMinor: string | null; currency: string | null; note: string }[];
}

export function fetchReconciliations(): Promise<{ runs: ReconciliationRun[] }> {
  return api.get<{ runs: ReconciliationRun[] }>('/admin/finance/reconciliations');
}

export const runReconciliation = (periodStart: string, periodEnd: string): Promise<ReconciliationRun> =>
  api.post<ReconciliationRun>('/admin/finance/reconcile', { periodStart, periodEnd });

export interface PayoutRunResult {
  paid: { sellerAccountId: string; payoutId: string; amountMinor: string; currency: string }[];
  failed: { sellerAccountId: string; payoutId: string; reason: string }[];
  skipped: { sellerAccountId: string; reason: string }[];
}

export const runPayouts = (): Promise<PayoutRunResult> => api.post<PayoutRunResult>('/admin/finance/payouts/run', {});
export const refreshEscrow = (): Promise<Record<string, number>> =>
  api.post<Record<string, number>>('/admin/finance/escrow/refresh', {});
