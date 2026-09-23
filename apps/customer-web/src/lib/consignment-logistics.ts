/**
 * Handing a confirmed consignment to whoever will carry it, from Seller Hub.
 *
 * The shapes mirror `consignment-logistics.service.ts` on the server. Every
 * decision - who is eligible, what stage it is at, whether the seller may
 * still move it - is made there and sent down; this file only carries it.
 */
import { api, postFile } from './api';
import type { CarrierSetupStatus, OutsideCarrier } from './carrier-providers';

export type LogisticsStage =
  | 'AWAITING_LOGISTICS_ASSIGNMENT'
  | 'PARTNER_REJECTED'
  | 'ASSIGNMENT_PENDING'
  | 'CARRIER_BOOKING_PENDING'
  | 'DRIVER_ASSIGNMENT_REQUIRED'
  | 'DRIVER_ASSIGNED'
  | 'PICKUP_SCHEDULED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'RETURNING'
  | 'RETURNED'
  | 'CANCELLED';

export type HistoryState =
  | 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'COMPLETED'
  | 'BOOKING_REQUIRED' | 'BOOKED' | 'CANCELLED';

export type CarrierNote =
  | 'API_CREDENTIALS_REQUIRED' | 'NO_OFFICIAL_API' | 'MANUAL_BOOKING_AVAILABLE' | 'ORIGIN_NOT_SERVED'
  | 'PALLETS_NOT_CARRIED' | 'CONTAINERS_NOT_CARRIED' | 'FREIGHT_SERVICE_REQUIRED';

export type PartnerRefusal =
  | 'NOT_LINKED' | 'LINK_NOT_APPROVED' | 'LINK_SUSPENDED' | 'LINK_NOT_IN_EFFECT'
  | 'PARTNER_NOT_ACTIVE' | 'OUTSIDE_AGREED_COUNTRIES' | 'CAPABILITY_NOT_AGREED';

export type ManualMilestone =
  | 'PICKED_UP' | 'IN_TRANSIT' | 'DELAYED' | 'OUT_FOR_DELIVERY' | 'DELIVERY_ATTEMPTED'
  | 'DELIVERED' | 'DELIVERY_FAILED' | 'RETURN_REQUESTED' | 'RETURN_IN_TRANSIT' | 'RETURNED';

export const SELLER_DOCUMENT_KINDS = [
  'PROOF_OF_DELIVERY', 'DELIVERY_PHOTO', 'SHIPPING_LABEL', 'PACKING_LIST',
  'COMMERCIAL_INVOICE', 'CUSTOMS_DOCUMENT', 'OTHER',
] as const;
export type SellerDocumentKind = (typeof SELLER_DOCUMENT_KINDS)[number];

export type AssignBlock = 'SELLER_ORDER_NOT_CONFIRMED' | 'COLLECTED' | 'FINISHED' | null;

export interface ManualBooking {
  id: string;
  provider: OutsideCarrier;
  carrierName: string;
  status: 'BOOKING_REQUIRED' | 'BOOKED';
  serviceName: string | null;
  pickupReference: string | null;
  carrierTrackingNumber: string | null;
  trackingPageUrl: string | null;
  expectedPickupAt: string | null;
  expectedDeliveryAt: string | null;
  /** Minor units, as a string. */
  shippingCostMinor: string | null;
  currency: string | null;
  createdAt: string;
  bookedAt: string | null;
}

export interface ConsignmentLogisticsState {
  id: string;
  reference: string;
  status: string;
  stage: LogisticsStage;
  mode: 'NONE' | 'PARTNER' | 'MANUAL_CARRIER';
  canAssign: boolean;
  assignBlock: AssignBlock;
  partner: { id: string; displayName: string; assignmentState: string; respondBy: string | null } | null;
  manualBooking: ManualBooking | null;
  driver: { isAssigned: boolean; maskedName: string | null };
  carrierTrackingNumber: string | null;
  trackingPageUrl: string | null;
  history: {
    kind: 'PARTNER' | 'MANUAL_CARRIER';
    carrierName: string;
    state: HistoryState;
    at: string;
    reason: string | null;
  }[];
}

export interface PartnerOption {
  logisticsPartnerId: string;
  displayName: string;
  partnerCode: string;
  relationshipType: string;
  isEligible: boolean;
  refusal: PartnerRefusal | null;
  serviceability: string[];
  reason: string | null;
}

export interface ManualCarrierOption {
  provider: OutsideCarrier;
  name: string;
  isAvailable: boolean;
  notes: CarrierNote[];
  setupStatus: CarrierSetupStatus;
  automaticBookingAvailable: boolean;
}

export interface ConsignmentSummary {
  id: string;
  reference: string;
  sellerOrderNumber: string | null;
  origin: { city: string | null; countryCode: string; contactName: string | null };
  destination: { city: string | null; postalCode: string | null; countryCode: string };
  loadType: 'PARCEL' | 'CARTON' | 'PALLET' | 'FCL' | 'LCL';
  packageCount: number;
  totalWeightGrams: number;
  packages: {
    sequence: number;
    weightGrams: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    packagingType: string | null;
  }[];
  pickupBy: string | null;
  deliverBy: string | null;
  handling: {
    coldChain: boolean;
    temperatureControlled: boolean;
    sterile: boolean;
    dangerousGoods: boolean;
    fragile: boolean;
    notes: string | null;
  };
}

export interface LogisticsOptions {
  consignment: ConsignmentSummary;
  state: ConsignmentLogisticsState;
  partners: PartnerOption[];
  carriers: ManualCarrierOption[];
}

const base = (shipmentId: string): string =>
  `/seller/consignments/${encodeURIComponent(shipmentId)}`;

export function fetchLogisticsOptions(shipmentId: string): Promise<LogisticsOptions> {
  return api.get<LogisticsOptions>(`${base(shipmentId)}/carrier-options`);
}

export function assignPartner(input: {
  shipmentId: string;
  logisticsPartnerId: string;
  reason?: string | null;
}): Promise<{ assignmentId: string }> {
  return api.post(`${base(input.shipmentId)}/carrier`, {
    logisticsPartnerId: input.logisticsPartnerId,
    reason: input.reason ?? null,
  });
}

export function createManualBooking(input: {
  shipmentId: string;
  provider: OutsideCarrier;
  reason?: string | null;
}): Promise<{ booking: ManualBooking; idempotent: boolean }> {
  return api.post(`${base(input.shipmentId)}/manual-booking`, {
    provider: input.provider,
    reason: input.reason ?? null,
  });
}

export interface ManualBookingDetails {
  serviceName?: string | null;
  pickupReference?: string | null;
  carrierTrackingNumber?: string | null;
  expectedPickupAt?: string | null;
  expectedDeliveryAt?: string | null;
  shippingCostMinor?: string | null;
  currency?: string | null;
}

export function updateManualBooking(input: {
  shipmentId: string;
  details: ManualBookingDetails;
}): Promise<{ booking: ManualBooking }> {
  return api.patch(`${base(input.shipmentId)}/manual-booking`, input.details);
}

export function withdrawCarrier(input: {
  shipmentId: string;
  reason: string;
}): Promise<{ state: ConsignmentLogisticsState }> {
  return api.post(`${base(input.shipmentId)}/withdraw`, { reason: input.reason });
}

export function recordMilestone(input: {
  shipmentId: string;
  status: string;
  note?: string | null;
  reason?: string | null;
  idempotencyKey: string;
}): Promise<{ state: ConsignmentLogisticsState }> {
  return api.post(`${base(input.shipmentId)}/milestones`, {
    status: input.status,
    note: input.note ?? null,
    reason: input.reason ?? null,
    idempotencyKey: input.idempotencyKey,
  });
}

export function attachDocument(input: {
  shipmentId: string;
  kind: SellerDocumentKind;
  file: File;
}): Promise<{ document: { id: string; kind: string; fileName: string } }> {
  const form = new FormData();
  form.append('kind', input.kind);
  form.append('file', input.file);
  return postFile(`${base(input.shipmentId)}/documents`, form);
}

export interface SellerTracking {
  state: ConsignmentLogisticsState;
  events: { id: string; status: string; description: string | null; occurredAt: string; source: string }[];
  documents: { id: string; kind: string; fileName: string; createdAt: string }[];
}

export function fetchSellerTracking(shipmentId: string): Promise<SellerTracking> {
  return api.get<SellerTracking>(`${base(shipmentId)}/tracking`);
}

export function raiseConsignment(sellerOrderId: string): Promise<{ consignments: ConsignmentLogisticsState[] }> {
  return api.post(`/seller/orders/${encodeURIComponent(sellerOrderId)}/consignments`, {});
}

/**
 * The seller milestones the server accepts from each status, for a
 * hand-booked consignment. The server's state machine is the authority; this
 * only decides which buttons to draw.
 */
export const NEXT_MANUAL_MILESTONES: Readonly<Record<string, readonly ManualMilestone[]>> = Object.freeze({
  PICKUP_SCHEDULED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELAYED'],
  DELAYED: ['IN_TRANSIT', 'OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_ATTEMPTED'],
  DELIVERY_ATTEMPTED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURN_IN_TRANSIT'],
  RETURN_IN_TRANSIT: ['RETURNED'],
});

/** Milestones the server refuses without a written reason. */
export const MILESTONES_NEEDING_REASON: ReadonlySet<ManualMilestone> = new Set<ManualMilestone>([
  'DELAYED',
  'DELIVERY_ATTEMPTED',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
]);
