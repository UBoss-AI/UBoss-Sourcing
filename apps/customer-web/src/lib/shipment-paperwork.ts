/**
 * Trade documents and shipment booking (checklist Master rows 42 and 56).
 *
 * The seller records each consignment's certificate of origin, waybill and
 * category documents, and books its mode, Incoterm, ports and pickup. The
 * buyer reads both back as the shipment details of their order.
 */
import { BASE_URL, api, postFile } from './api';

export const TRADE_DOCUMENT_KINDS = [
  'CERTIFICATE_OF_ORIGIN',
  'BILL_OF_LADING',
  'AIR_WAYBILL',
  'SHIPPING_BILL',
  'INSPECTION_CERTIFICATE',
  'EXPORT_LICENCE',
  'IMPORT_LICENCE',
  'OTHER',
] as const;
export type TradeDocumentKind = (typeof TRADE_DOCUMENT_KINDS)[number];

export type TradeValidation = 'PENDING_REVIEW' | 'VALID' | 'REJECTED' | 'EXPIRED';

export interface TradeDocumentVersion {
  id: string;
  version: number;
  source: 'GENERATED' | 'UPLOADED' | 'REFERENCE';
  referenceNumber: string | null;
  issuerName: string;
  issuedOn: string | null;
  expiresOn: string | null;
  fileName: string | null;
  hasFile: boolean;
  validation: TradeValidation;
  validationNote: string | null;
  superseded: boolean;
  createdByLabel: string;
  createdAt: string;
}

export interface TradeDocument {
  id: string;
  kind: string;
  title: string;
  shipmentId: string | null;
  buyerVisible: boolean;
  currentVersion: number;
  current: TradeDocumentVersion | null;
  versions: TradeDocumentVersion[];
}

export type ResponsibleParty = 'SELLER' | 'BUYER' | 'FORWARDER' | 'OPERATOR';
export type TradeRestriction = 'NONE' | 'RESTRICTED' | 'PROHIBITED';
export type ComplianceItemStatus = 'VALID' | 'PENDING_REVIEW' | 'MISSING' | 'REJECTED' | 'EXPIRED' | 'NO_DOCUMENT';
export type HoldCode = 'PROHIBITED' | 'DOCUMENT_MISSING' | 'DOCUMENT_NOT_VALID' | 'HS_UNVERIFIED' | 'HS_REJECTED';

export interface RequiredTradeDocument {
  kind: string;
  name: string;
  ruleName: string;
  note: string | null;
  satisfied: boolean;
  /** Absent from a server older than JOURNEY-049: read as SELLER / NONE. */
  responsibleParty?: ResponsibleParty;
  restriction?: TradeRestriction;
  status?: ComplianceItemStatus;
}

/** Destination readiness of one seller order (JOURNEY-049). */
export interface SellerOrderCompliance {
  destination: string;
  restrictions: { ruleName: string; restriction: TradeRestriction; requiresHsVerification: boolean; note: string | null; skus: string[] }[];
  holds: {
    key: string;
    code: HoldCode;
    ruleName: string;
    responsibleParty: ResponsibleParty;
    documentKind: string | null;
    sku: string | null;
    covered: boolean;
  }[];
  open: boolean;
  overridden: boolean;
  override: { reason: string; grantedByLabel: string; grantedAt: string; revokedAt: string | null } | null;
}

export const OPEN_COMPLIANCE: SellerOrderCompliance = {
  destination: '',
  restrictions: [],
  holds: [],
  open: true,
  overridden: false,
  override: null,
};

export interface SellerTradeDocuments {
  documents: TradeDocument[];
  required: RequiredTradeDocument[];
  compliance: SellerOrderCompliance;
  issued: { commercialInvoices: number; packingLists: number };
  consignments: { id: string; reference: string }[];
}

export interface TradeDocumentFields {
  kind: string;
  shipmentId: string | null;
  title?: string | null;
  referenceNumber?: string | null;
  issuerName: string;
  issuedOn?: string | null;
  expiresOn?: string | null;
}

export async function fetchSellerTradeDocuments(sellerOrderId: string): Promise<SellerTradeDocuments> {
  const body = await api.get<Partial<SellerTradeDocuments>>(
    `/seller/orders/${encodeURIComponent(sellerOrderId)}/trade-documents`,
  );
  return {
    documents: body.documents ?? [],
    required: body.required ?? [],
    compliance: body.compliance ?? OPEN_COMPLIANCE,
    issued: body.issued ?? { commercialInvoices: 0, packingLists: 0 },
    consignments: body.consignments ?? [],
  };
}

/** A new version by its number only: a waybill, a shipping bill. */
export function recordTradeDocumentReference(
  sellerOrderId: string,
  fields: TradeDocumentFields,
): Promise<{ document: TradeDocument }> {
  return api.post(`/seller/orders/${encodeURIComponent(sellerOrderId)}/trade-documents`, {
    kind: fields.kind,
    shipmentId: fields.shipmentId,
    title: fields.title ?? null,
    referenceNumber: fields.referenceNumber ?? null,
    issuerName: fields.issuerName,
    issuedOn: fields.issuedOn ?? null,
    expiresOn: fields.expiresOn ?? null,
  });
}

/** A new version as a PDF or image, with the same fields as form parts. */
export function uploadTradeDocument(
  sellerOrderId: string,
  fields: TradeDocumentFields,
  file: File,
): Promise<{ document: TradeDocument }> {
  const form = new FormData();
  // Fields before the file: the server reads them off the file part.
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value !== '') form.append(name, value);
  }
  form.append('file', file);
  return postFile(`/seller/orders/${encodeURIComponent(sellerOrderId)}/trade-documents/upload`, form);
}

export function generateCertificateOfOrigin(
  sellerOrderId: string,
  shipmentId: string | null,
): Promise<{ document: TradeDocument }> {
  return api.post(
    `/seller/orders/${encodeURIComponent(sellerOrderId)}/trade-documents/certificate-of-origin`,
    { shipmentId },
  );
}

export function sellerTradeDocumentFileUrl(versionId: string): string {
  return `${BASE_URL}/seller/trade-documents/versions/${encodeURIComponent(versionId)}/file`;
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export const TRANSPORT_MODES = ['ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Incoterms 2020, in the order the ICC lists them. */
export const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

export const BOOKING_CARRIERS = ['DHL', 'FEDEX', 'INDIA_POST'] as const;

export interface BookingTerms {
  mode: TransportMode;
  incoterm: string;
  incotermPlace: string | null;
  originPort: string | null;
  destinationPort: string | null;
  routeNote: string | null;
  pickupDate: string | null;
  pickupWindowFrom: string | null;
  pickupWindowTo: string | null;
  /** Cargo insurance (JOURNEY-046). Money is minor units as strings. */
  insured?: boolean;
  insuredValueMinor?: string | null;
  insurancePremiumMinor?: string | null;
  insuranceBasisPointsApplied?: number | null;
  insuranceCurrency?: string | null;
}

export interface InsuranceOffer {
  offered: boolean;
  basisPoints: number;
  maxInsuredBasisPoints: number;
  goodsValueMinor: string | null;
  maxInsuredValueMinor: string | null;
  currency: string | null;
}

export interface DispatchReadiness {
  inspection: { open: boolean; reason: string } | null;
  compliance: { open: boolean; holds: number; overridden: boolean };
}

export interface CarrierSummary {
  kind: 'NONE' | 'PARTNER' | 'MANUAL_CARRIER' | 'OWN_ACCOUNT';
  name: string | null;
  trackingNumber: string | null;
}

export interface SellerShipmentBooking {
  shipmentId: string;
  reference: string;
  crossBorder: boolean;
  originCountry?: string;
  destinationCountry?: string;
  insurance?: InsuranceOffer;
  dispatchReadiness?: DispatchReadiness;
  terms: (BookingTerms & { updatedByLabel: string; updatedAt: string }) | null;
  carrier: CarrierSummary;
  canEdit: boolean;
}

export interface BookingInput
  extends Omit<BookingTerms, 'mode' | 'insurancePremiumMinor' | 'insuranceBasisPointsApplied' | 'insuranceCurrency'> {
  mode: string;
  manualCarrier: (typeof BOOKING_CARRIERS)[number] | null;
}

/** One of the operator's rate cards that can carry the consignment, with its validity. */
export interface FreightOption {
  laneId: string;
  laneName: string;
  mode: TransportMode;
  carrierName: string;
  serviceLevel: string;
  transitDaysMin: number;
  transitDaysMax: number;
  currency: string;
  totalMinor: string;
  validFrom: string;
  validTo: string | null;
}

export interface FreightOptions {
  originCountry: string;
  destinationCountry: string;
  weightGrams: number;
  options: FreightOption[];
}

export async function fetchFreightOptions(shipmentId: string): Promise<FreightOptions> {
  const body = await api.get<Partial<FreightOptions>>(
    `/seller/consignments/${encodeURIComponent(shipmentId)}/freight-options`,
  );
  return {
    originCountry: body.originCountry ?? '',
    destinationCountry: body.destinationCountry ?? '',
    weightGrams: body.weightGrams ?? 0,
    options: body.options ?? [],
  };
}

export function fetchShipmentBooking(shipmentId: string): Promise<{ booking: SellerShipmentBooking }> {
  return api.get(`/seller/consignments/${encodeURIComponent(shipmentId)}/booking`);
}

export function saveShipmentBooking(
  shipmentId: string,
  input: BookingInput,
): Promise<{ booking: SellerShipmentBooking }> {
  return api.put(`/seller/consignments/${encodeURIComponent(shipmentId)}/booking`, input);
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

export interface BuyerShipmentDetails {
  shipments: {
    shipmentId: string;
    reference: string;
    sellerName: string | null;
    terms: BookingTerms | null;
    carrier: CarrierSummary;
  }[];
  documents: {
    id: string;
    kind: string;
    title: string;
    shipmentReference: string | null;
    sellerName: string;
    versionId: string;
    version: number;
    referenceNumber: string | null;
    issuerName: string;
    issuedOn: string | null;
    expiresOn: string | null;
    hasFile: boolean;
    validation: TradeValidation;
  }[];
  /** What the destination rules ask the buyer to produce (JOURNEY-049). */
  buyerActions: {
    sellerName: string;
    ruleName: string;
    documentName: string | null;
    restriction: TradeRestriction;
    note: string | null;
  }[];
}

export async function fetchBuyerShipmentDetails(orderId: string): Promise<BuyerShipmentDetails> {
  const body = await api.get<Partial<BuyerShipmentDetails>>(`/orders/${encodeURIComponent(orderId)}/shipment-details`);
  return { shipments: body.shipments ?? [], documents: body.documents ?? [], buyerActions: body.buyerActions ?? [] };
}

export function buyerTradeDocumentFileUrl(orderId: string, versionId: string): string {
  return `${BASE_URL}/orders/${encodeURIComponent(orderId)}/trade-documents/${encodeURIComponent(versionId)}/file`;
}
