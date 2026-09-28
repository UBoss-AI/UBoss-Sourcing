/**
 * Finance → Commission Invoices: the operator's invoices to sellers for the
 * platform commission. Mirrors `backend/src/http/routes/commission-invoices.admin.ts`.
 *
 * Every figure comes from the server as `{ minor, currency, formatted }`. The
 * panel never works out a commission, a tax or a total: it names a seller
 * order, a draft or a credit basis, and shows what the server says back.
 */
import { BASE_URL, api, downloadFile } from './api';
import type { Money } from './format';

export type CommissionInvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_CREDITED' | 'FULLY_CREDITED' | 'VOID';
export type CollectionStatus = 'OUTSTANDING' | 'PAID' | 'ADJUSTED_AGAINST_SETTLEMENT';
export type CreditReason =
  | 'ORDER_CANCELLED'
  | 'FULL_REFUND'
  | 'PARTIAL_REFUND'
  | 'COMMISSION_REVERSAL'
  | 'CHARGEBACK'
  | 'SELLER_DISPUTE'
  | 'TAX_ADJUSTMENT';
export type CreditBasis = 'FULL' | 'PROPORTIONAL_TO_REFUND' | 'CUSTOM_AMOUNT';

export const INVOICE_STATUSES: readonly CommissionInvoiceStatus[] = ['DRAFT', 'ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED', 'VOID'];
export const COLLECTION_STATUSES: readonly CollectionStatus[] = ['OUTSTANDING', 'PAID', 'ADJUSTED_AGAINST_SETTLEMENT'];
export const CREDIT_REASONS: readonly CreditReason[] = [
  'ORDER_CANCELLED',
  'FULL_REFUND',
  'PARTIAL_REFUND',
  'COMMISSION_REVERSAL',
  'CHARGEBACK',
  'SELLER_DISPUTE',
  'TAX_ADJUSTMENT',
];

export interface Problem {
  code: string;
  message: string;
  field?: string;
}

export interface CommissionInvoiceRow {
  id: string;
  number: string | null;
  status: CommissionInvoiceStatus;
  documentType: string;
  sellerAccountId: string;
  sellerName: string;
  sellerDisplayName: string;
  sellerCountry: string;
  orderId: string;
  orderNumber: string;
  sellerOrderNumber: string;
  currency: string;
  taxable: Money;
  totalTax: Money;
  grandTotal: Money;
  credited: Money;
  collectionStatus: CollectionStatus;
  issueDate: string | null;
  createdAt: string;
  hasIssues: boolean;
  documentId: string | null;
  creditSuggestion: string | null;
}

export interface Page<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export interface CandidateRow {
  sellerOrderGroupId: string;
  sellerOrderNumber: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  sellerOrderStatus: string;
  sellerAccountId: string;
  sellerName: string;
  currency: string;
  platformFee: Money;
  platformFeeTax: Money;
  computedAt: string;
  blockers: Problem[];
}

export interface CommissionInvoiceLine {
  position: number;
  description: string;
  detail: string | null;
  serviceCode: string | null;
  orderReference: string;
  feeRatePercent: string | null;
  basis: Money;
  policyVersion: number | null;
  taxable: Money;
  taxRatePercent: string;
  cgst: Money;
  sgst: Money;
  igst: Money;
  otherTax: Money;
  tax: Money;
  total: Money;
}

export interface CommissionDocumentRef {
  id: string;
  fileName: string;
  contentHash: string;
  sizeBytes: number;
  pageCount: number;
}

export interface CommissionInvoiceDetail {
  id: string;
  status: CommissionInvoiceStatus;
  documentType: string;
  number: string | null;
  financialYear: string | null;
  issueDate: string | null;
  issuedAt: string | null;
  dueDate: string | null;
  currency: string;
  taxTreatment: string;
  reverseCharge: boolean;
  placeOfSupply: { code: string; name: string } | null;
  snapshotHash: string;
  issuer: {
    legalName: string;
    tradeName: string | null;
    addressLines: string[];
    taxRegistrationLabel: string;
    taxRegistrationNumber: string | null;
    stateCode: string | null;
    stateName: string | null;
  };
  seller: {
    sellerAccountId: string;
    legalName: string;
    displayName: string;
    addressLines: string[];
    country: string | null;
    taxId: string | null;
    stateCode: string | null;
    stateName: string | null;
    email: string | null;
  };
  source: {
    orderId: string;
    orderNumber: string;
    sellerOrderNumber: string;
    paymentReference: string | null;
    settlementReference: string | null;
    collection: 'PAYABLE_BY_SELLER' | 'ADJUSTED_AGAINST_SETTLEMENT';
    feePolicyVersion: number | null;
  };
  notes: string[];
  issues: Problem[];
  blockers: Problem[];
  canIssue: boolean;
  canVoid: boolean;
  lines: CommissionInvoiceLine[];
  taxLabels: { cgst: string; sgst: string; igst: string; other: string };
  totals: Record<'subtotal' | 'discount' | 'taxable' | 'cgst' | 'sgst' | 'igst' | 'otherTax' | 'totalTax' | 'rounding' | 'grandTotal' | 'credited' | 'outstanding', Money>;
  amountInWords: string | null;
  collection: { status: CollectionStatus; reference: string | null; collectedAt: string | null };
  sources: {
    orderStatus: string;
    sellerOrderStatus: string;
    orderPaid: Money;
    orderTotal: Money;
    settlement: {
      grossProceeds: Money;
      sellerDeliveryProceeds: Money;
      feeBasis: Money;
      platformFee: Money;
      platformFeeTax: Money;
      refundsAdjustments: Money;
      feeTaxRatePercent: string;
      feeTaxLabel: string;
      policyVersion: number | null;
      computedAt: string;
    };
  };
  creditSuggestion: string | null;
  document: CommissionDocumentRef | null;
  creditNotes: {
    id: string;
    number: string;
    issueDate: string;
    reason: CreditReason;
    basis: CreditBasis;
    note: string | null;
    taxable: Money;
    totalTax: Money;
    grandTotal: Money;
    document: CommissionDocumentRef | null;
  }[];
  history: {
    id: string;
    action: string;
    fromStatus: string | null;
    toStatus: string | null;
    actor: string | null;
    snapshotHash: string | null;
    detail: Record<string, unknown> | null;
    at: string;
  }[];
  voidReason: string | null;
  createdAt: string;
}

export interface CommissionSettings {
  version: number;
  saved: boolean;
  legalEntityCode: string;
  legalName: string | null;
  tradeName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  stateCode: string | null;
  taxRegime: 'IN_GST' | 'VAT' | 'OTHER' | 'NONE';
  taxRegistrationLabel: string;
  taxRegistrationNumber: string | null;
  businessIdentifierLabel: string;
  businessIdentifier: string | null;
  businessEmail: string | null;
  supportContact: string | null;
  jurisdictionNote: string | null;
  serviceCode: string | null;
  serviceCodeLabel: string;
  serviceDescription: string;
  invoicePrefix: string;
  creditNotePrefix: string;
  sequencePadding: number;
  financialYearStartMonth: number;
  eligibleStage: 'CONFIRMED' | 'SHIPPED' | 'DELIVERED';
  paymentTermsDays: number | null;
  roundGrandTotal: boolean;
  requireSellerTaxId: boolean;
  exportLutReference: string | null;
  zeroTaxDocumentType: 'INVOICE' | 'BILL_OF_SUPPLY';
  allowVoidAfterIssue: boolean;
  footerNote: string | null;
  missing: string[];
  updatedAt: string | null;
}

export interface OrderCommission {
  orderId: string;
  sellerOrders: {
    sellerOrderGroupId: string;
    sellerOrderNumber: string;
    sellerName: string;
    sellerAccountId: string;
    platformFee: Money | null;
    platformFeeTax: Money | null;
    blockers: Problem[];
    active: { id: string; status: CommissionInvoiceStatus; number: string | null; grandTotal: Money; documentId: string | null } | null;
    previous: { id: string; status: CommissionInvoiceStatus; number: string | null }[];
  }[];
}

export interface ListFilters {
  q?: string | undefined;
  status?: string | undefined;
  collectionStatus?: string | undefined;
  country?: string | undefined;
  currency?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

/** A fresh key per user intent. A retry of the same request reuses it. */
export function newIdempotencyKey(): string {
  return `cinv-${crypto.randomUUID()}`;
}

export const commissionApi = {
  list: (filters: ListFilters) => api.get<Page<CommissionInvoiceRow>>('/admin/commission-invoices', { query: { ...filters } }),
  candidates: (q: string, page: number, pageSize: number) =>
    api.get<Page<CandidateRow>>('/admin/commission-invoices/candidates', { query: { q, page, pageSize } }),
  read: (id: string) => api.get<CommissionInvoiceDetail>(`/admin/commission-invoices/${id}`),
  forOrder: (orderId: string) => api.get<OrderCommission>(`/admin/orders/${orderId}/commission-invoices`),
  generate: (sellerOrderGroupId: string, idempotencyKey: string) =>
    api.post<{ invoice: CommissionInvoiceDetail; created: boolean }>(`/admin/seller-orders/${sellerOrderGroupId}/commission-invoice`, undefined, { idempotencyKey }),
  regenerate: (id: string) => api.post<CommissionInvoiceDetail>(`/admin/commission-invoices/${id}/regenerate`),
  issue: (id: string, snapshotHash: string) =>
    api.post<{ invoice: CommissionInvoiceDetail; created: boolean }>(`/admin/commission-invoices/${id}/issue`, { snapshotHash }),
  discard: (id: string, reason: string) => api.post<CommissionInvoiceDetail>(`/admin/commission-invoices/${id}/discard`, { reason }),
  void: (id: string, reason: string) => api.post<CommissionInvoiceDetail>(`/admin/commission-invoices/${id}/void`, { reason }),
  recordCollection: (id: string, reference: string) =>
    api.post<CommissionInvoiceDetail>(`/admin/commission-invoices/${id}/collection`, { reference }),
  credit: (id: string, body: { reason: CreditReason; basis: CreditBasis; taxableMinor?: string; note?: string }, idempotencyKey: string) =>
    api.post<{ invoice: CommissionInvoiceDetail; creditNoteId: string; created: boolean }>(`/admin/commission-invoices/${id}/credit-notes`, body, { idempotencyKey }),
  settings: () => api.get<CommissionSettings>('/admin/commission-invoices/settings'),
  saveSettings: (body: Omit<CommissionSettings, 'saved' | 'missing' | 'updatedAt' | 'version'> & { expectedVersion: number }) =>
    api.put<CommissionSettings>('/admin/commission-invoices/settings', body),
};

/** Fetch the draft preview as a PDF the browser can show in a frame. */
export async function previewUrl(id: string): Promise<string> {
  const url = new URL(`${BASE_URL}/admin/commission-invoices/${id}/preview.pdf`, window.location.origin);
  const response = await fetch(url.toString(), { credentials: 'include' });
  if (!response.ok) throw new Error(`The preview could not be produced (${String(response.status)}).`);
  return URL.createObjectURL(await response.blob());
}

/** Download an issued PDF through a single-use link minted for this session. */
export async function downloadCommissionDocument(documentId: string, fallbackName: string): Promise<void> {
  const link = await api.post<{ url: string }>(`/admin/commission-invoices/documents/${documentId}/link`);
  await downloadFile(link.url.replace(/^\/api\/v1/, ''), fallbackName);
}
