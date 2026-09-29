/**
 * Where the buyer's parcels are: the carrier timeline, the ETA and the proof
 * of delivery, per consignment on one of their own orders.
 *
 * The server decides what may be shown (`buyer-tracking.service.ts`); these
 * types are what it sends. Nothing here is the carrier's own record - no
 * internal notes, no driver, no coordinates - because none of it is sent.
 */
import { api } from './api';
import type { DocumentLink } from './seller-documents';

export type TroubleCategory =
  | 'CUSTOMS'
  | 'DELAY'
  | 'ADDRESS'
  | 'MISSED_DELIVERY'
  | 'DAMAGE'
  | 'LOST'
  | 'TEMPERATURE';

export interface TrackingEvent {
  status: string;
  kind: 'MILESTONE' | 'TROUBLE' | 'CORRECTION';
  trouble: TroubleCategory | null;
  /** The sentence written for the buyer, or null - then the status label is shown. */
  description: string | null;
  occurredAt: string;
  /** A carrier hub's name, from the carrier's own feed only. */
  location: string | null;
}

export interface TrackingEta {
  /**
   * ESTIMATE: the carrier's estimate. REVISED: an estimate moved because of a
   * problem. PROMISE: the carrier's service window. NONE: no date exists.
   * FINISHED: delivered, returned or cancelled - there is nothing to estimate.
   */
  source: 'ESTIMATE' | 'REVISED' | 'PROMISE' | 'NONE' | 'FINISHED';
  at: string | null;
  isLate: boolean;
}

export interface TrackingProofOfDelivery {
  deliveredAt: string;
  receivedBy: string | null;
  receivedByRole: string | null;
  confirmedWithCode: boolean;
  businessStamped: boolean;
  signature: { captured: boolean; available: boolean };
  photo: { captured: boolean; available: boolean };
}

export interface ConsignmentTracking {
  id: string;
  reference: string;
  status: string;
  events: TrackingEvent[];
  openTrouble: { category: TroubleCategory; since: string }[];
  eta: TrackingEta;
  proofOfDelivery: TrackingProofOfDelivery | null;
  deliveredWithoutProof: boolean;
}

export function fetchOrderTracking(orderId: string): Promise<{ consignments: ConsignmentTracking[] }> {
  return api.get(`/orders/${encodeURIComponent(orderId)}/tracking`);
}

export type PodImageKind = 'signature' | 'photo';

/** A single-use link, valid for a few minutes, to one proof-of-delivery image. */
export function proofOfDeliveryLink(
  orderId: string,
  shipmentId: string,
  kind: PodImageKind,
): Promise<DocumentLink> {
  return api.post(
    `/orders/${encodeURIComponent(orderId)}/shipments/${encodeURIComponent(shipmentId)}` +
      `/proof-of-delivery/${kind}/link`,
    {},
  );
}
