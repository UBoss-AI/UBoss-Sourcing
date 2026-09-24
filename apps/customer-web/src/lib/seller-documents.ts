/**
 * Seller invoices and packing lists: the Seller Hub's and the buyer's client.
 *
 * Nothing here computes a tax, a total or a number. Every figure comes from
 * the server, which renders the same figures into the PDF, so the screen and
 * the legal document cannot disagree. Downloads go through a single-use link
 * the server mints for the signed-in person; the PDF itself is never cached.
 */
import { ApiError, BASE_URL, api, type ApiErrorBody } from './api';
import type { Money } from './format';

export type SellerDocumentStatus =
  | 'DRAFT'
  | 'VALIDATION_REQUIRED'
  | 'READY_TO_ISSUE'
  | 'ISSUED'
  | 'VOIDED'
  | 'CREDIT_NOTE_REQUIRED'
  | 'SUPERSEDED';

export type DocumentKind = 'invoice' | 'packing-list';

export type PackagesLock = 'SCANNED_OUT' | 'LABEL_BOUGHT' | 'PACKING_LIST_ISSUED';

/** One thing stopping a document from being issued. */
export interface DocumentIssue {
  field?: string;
  code?: string;
  message?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface InvoiceTotals {
  taxable: Money;
  discount: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
  otherTax: Money;
  freight: Money;
  totalTax: Money;
  grandTotal: Money;
}

/** One line as printed on the invoice. Amounts are minor units, as strings. */
export interface InvoiceLine {
  orderItemId: string;
  description: string;
  sku: string;
  hsn: string | null;
  countryOfOrigin: string | null;
  orderedAs: string | null;
  quantity: number;
  unitPriceMinor: string;
  taxableMinor: string;
  ratePercent: string;
  taxMinor: string;
  totalMinor: string;
}

export interface SellerInvoice {
  id: string;
  kind: 'TAX_INVOICE' | 'CREDIT_NOTE';
  status: SellerDocumentStatus;
  jurisdiction: 'IN_GST' | 'EU_VAT' | 'GENERIC';
  number: string | null;
  financialYear: string | null;
  issueDate: string | null;
  issuedAt: string | null;
  shipmentId: string;
  orderId: string;
  creditsInvoiceId: string | null;
  supplyType: string | null;
  reverseCharge: boolean;
  currency: string;
  placeOfSupply: { stateCode: string; stateName: string } | null;
  lines: InvoiceLine[] | null;
  totals: InvoiceTotals;
  amountInWords: string | null;
  validation: DocumentIssue[] | null;
  pageCount: number | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** Buyer and admin views only. */
  sellerName?: string;
}

export interface SellerPackingList {
  id: string;
  status: SellerDocumentStatus;
  number: string | null;
  shipmentId: string;
  orderId: string;
  issuedAt: string | null;
  packageCount: number;
  totalBaseUnits: number;
  netWeightGrams: string;
  grossWeightGrams: string;
  volumeCm3: string;
  vehicleRegistration: string | null;
  driverReference: string | null;
  validation: DocumentIssue[] | null;
  pageCount: number | null;
  voidReason: string | null;
  sellerName?: string;
}

export interface PackageContent {
  orderItemId: string;
  quantity: number;
  batchNumber: string;
  expiryDate: string | null;
  serialNumbers: string[] | null;
}

export interface ConsignmentPackage {
  id: string;
  reference: string;
  packagingType: string | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: number;
  netWeightGrams: number | null;
  containerNumber: string | null;
  sealNumber: string | null;
  scannedOutAt: string | null;
  contents: PackageContent[];
}

export interface ConsignmentLine {
  orderItemId: string;
  quantity: number;
  name: string;
  sku: string;
  hsn: string | null;
}

export interface ConsignmentDocuments {
  id: string;
  shipmentReference: string;
  status: string;
  packedAt: string | null;
  splitFromShipmentId: string | null;
  packagesLocked: PackagesLock | null;
  lines: ConsignmentLine[];
  packages: ConsignmentPackage[];
  invoices: SellerInvoice[];
  packingLists: SellerPackingList[];
}

export interface PackageInput {
  packagingType: string;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  grossWeightGrams: number;
  netWeightGrams: number | null;
  containerNumber: string | null;
  sealNumber: string | null;
  contents: {
    orderItemId: string;
    quantity: number;
    batchNumber: string;
    expiryDate: string | null;
    serialNumbers: string[] | null;
  }[];
}

export interface DocumentLink {
  url: string;
  expiresAt: string;
}

// --- Seller Hub -----------------------------------------------------------------

export function fetchSellerOrderDocuments(
  sellerOrderId: string,
): Promise<{ consignments: ConsignmentDocuments[] }> {
  return api.get(`/seller/orders/${sellerOrderId}/documents`);
}

export function savePackages(
  shipmentId: string,
  packages: PackageInput[],
): Promise<{ consignment: ConsignmentDocuments }> {
  return api.put(`/seller/consignments/${shipmentId}/packages`, { packages });
}

export function splitConsignment(
  shipmentId: string,
  lines: { orderItemId: string; quantity: number }[],
): Promise<{ shipmentId: string; shipmentReference: string }> {
  return api.post(`/seller/consignments/${shipmentId}/split`, { lines });
}

export function previewInvoice(shipmentId: string): Promise<{ invoice: SellerInvoice }> {
  return api.post(`/seller/consignments/${shipmentId}/invoice/preview`);
}

export function issueInvoice(shipmentId: string): Promise<{ invoice: SellerInvoice }> {
  return api.post(`/seller/consignments/${shipmentId}/invoice/issue`);
}

export function previewPackingList(
  shipmentId: string,
): Promise<{ packingList: SellerPackingList }> {
  return api.post(`/seller/consignments/${shipmentId}/packing-list/preview`);
}

export function issuePackingList(shipmentId: string): Promise<{ packingList: SellerPackingList }> {
  return api.post(`/seller/consignments/${shipmentId}/packing-list/issue`);
}

export function supersedePackingList(
  shipmentId: string,
  reason: string,
): Promise<{ consignment: ConsignmentDocuments }> {
  return api.post(`/seller/consignments/${shipmentId}/packing-list/supersede`, { reason });
}

export function packConsignment(
  shipmentId: string,
): Promise<{ consignment: ConsignmentDocuments }> {
  return api.post(`/seller/consignments/${shipmentId}/pack`);
}

export function creditInvoice(
  invoiceId: string,
  reason: string,
): Promise<{ creditNote: SellerInvoice }> {
  return api.post(`/seller/invoices/${invoiceId}/credit`, { reason });
}

/** The PDF of the current draft or issued document, streamed inline. */
export function draftPdfUrl(shipmentId: string, kind: DocumentKind): string {
  return resolveApiUrl(`/api/v1/seller/consignments/${shipmentId}/${kind}/pdf`);
}

export function sellerDocumentLink(kind: DocumentKind, id: string): Promise<DocumentLink> {
  return api.post(`/seller/document-links/${kind}/${id}`);
}

export function sellerBatchLink(
  documents: { kind: DocumentKind; id: string }[],
): Promise<DocumentLink> {
  return api.post('/seller/document-links/batch', { documents });
}

// --- Invoice settings and trade codes ----------------------------------------------

export type InvoiceJurisdiction = 'IN_GST' | 'EU_VAT' | 'GENERIC';

export interface InvoiceSettingsInput {
  jurisdiction: InvoiceJurisdiction | null;
  invoiceSeries: string;
  creditNoteSeries: string;
  financialYearStartMonth: number;
  signatoryName: string | null;
  signatoryDesignation: string | null;
  lutReference: string | null;
  lutValidFrom: string | null;
  lutValidTo: string | null;
  footerNotes: string | null;
}

export interface InvoiceSettingsView {
  settings: (InvoiceSettingsInput & { version: number }) | null;
  identity: {
    legalName: string;
    registrationCountry: string;
    taxRegistrationNumber: string | null;
    gstinProblem: 'SHAPE' | 'STATE' | 'CHECKSUM' | null;
  };
}

export function fetchInvoiceSettings(): Promise<InvoiceSettingsView> {
  return api.get('/seller/invoice-settings');
}

export function saveInvoiceSettings(input: InvoiceSettingsInput): Promise<InvoiceSettingsView> {
  return api.put('/seller/invoice-settings', input);
}

export interface TradeCodes {
  id: string;
  hsnCode: string | null;
  countryOfOrigin: string | null;
}

export function fetchTradeCodes(offerId: string): Promise<TradeCodes> {
  return api.get(`/seller/offers/${offerId}/trade-codes`);
}

export function saveTradeCodes(
  offerId: string,
  input: { hsnCode: string | null; countryOfOrigin: string | null },
): Promise<TradeCodes> {
  return api.put(`/seller/offers/${offerId}/trade-codes`, input);
}

// --- The buyer ----------------------------------------------------------------------

export interface BuyerOrderDocuments {
  invoices: SellerInvoice[];
  packing: SellerPackingList[];
}

export function fetchBuyerOrderDocuments(orderId: string): Promise<BuyerOrderDocuments> {
  return api.get(`/documents/orders/${orderId}`);
}

export function buyerDocumentLink(id: string): Promise<DocumentLink> {
  return api.post(`/documents/buyer/invoice/${id}/link`);
}

// --- Public check -------------------------------------------------------------------

export type VerifyAnswer =
  | { valid: false }
  | {
      valid: true;
      kind: 'TAX_INVOICE' | 'CREDIT_NOTE' | 'PACKING_LIST';
      number: string;
      status: SellerDocumentStatus;
      issuedAt: string | null;
      issuer: string;
      packageCount?: number;
    };

export function verifyDocument(
  kind: DocumentKind,
  number: string,
  code: string,
): Promise<VerifyAnswer> {
  return api.get('/documents/verify', { query: { kind, number, code } });
}

// --- Helpers ------------------------------------------------------------------------

/**
 * A server path (`/api/v1/...`) as a URL this page can open. The API may sit
 * on another origin in development; through the tunnel it is this one.
 */
export function resolveApiUrl(path: string): string {
  const relative = path.replace(/^\/api\/v1/, '');
  return new URL(`${BASE_URL}${relative}`, window.location.origin).toString();
}

/**
 * Redeem a freshly minted single-use link and save the file.
 *
 * Fetched with credentials rather than navigated to: in development the API
 * sits on another port, and a link that has expired or was already used must
 * come back as a sentence on this page, not as a JSON body in a new tab.
 */
export async function openDocumentLink(link: DocumentLink): Promise<void> {
  const response = await fetch(resolveApiUrl(link.url), { credentials: 'include' });
  if (!response.ok) {
    let body: { error?: ApiErrorBody } | null = null;
    try {
      body = (await response.json()) as { error?: ApiErrorBody };
    } catch {
      body = null;
    }
    throw new ApiError(
      response.status,
      body?.error ?? { code: 'UNEXPECTED_RESPONSE', message: `HTTP ${String(response.status)}` },
    );
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? 'document.pdf';
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/** Mint a link and save the file it names: one step for a button. */
export async function downloadWith(mint: () => Promise<DocumentLink>): Promise<void> {
  await openDocumentLink(await mint());
}

/** Grams as kilograms with up to three decimals, for display only. */
export function gramsToKg(grams: string | number): string {
  const value = typeof grams === 'number' ? grams : Number(grams);
  return (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/**
 * The translation key for one validation issue.
 *
 * A path such as `lines.2.hsn` or `packages.PKG-3.weight` has an index or a
 * reference in it; the key replaces that part so one sentence covers every
 * line, and `meta` fills in which one.
 */
export function issueKey(issue: DocumentIssue): string {
  const field = (issue.field ?? '')
    .replace(/^lines\.\d+/, 'line')
    .replace(/^packages\.[^.]+\./, 'package.')
    .replace(/^contents\..+$/, 'contents');
  return `sellerDocs.issue.${field}.${issue.code ?? 'INVALID'}`;
}

export function statusTone(
  status: SellerDocumentStatus,
): 'neutral' | 'success' | 'warning' | 'danger' | 'brand' {
  switch (status) {
    case 'ISSUED':
      return 'success';
    case 'READY_TO_ISSUE':
      return 'brand';
    case 'VALIDATION_REQUIRED':
    case 'CREDIT_NOTE_REQUIRED':
      return 'warning';
    case 'VOIDED':
      return 'danger';
    default:
      return 'neutral';
  }
}
