/**
 * Tracking, as the BUYER sees it - and the seller's copy of the same facts.
 *
 * The carrier's portal holds a great deal about a consignment that is none of
 * the buyer's business: which carrier refused it and why, the driver's name,
 * the dispatcher's notes, the SLA clock, the coordinates of every scan. This
 * file is the one place that decides what crosses from that record to the
 * order page, and it decides by SELECTING - a column that is never read here
 * cannot reach a response.
 *
 * WHAT THE BUYER GETS, PER CONSIGNMENT
 *
 *   - **The timeline.** Every event that carries a sentence written for the
 *     buyer (`publicDescription`), plus the movement and trouble milestones
 *     even where nobody wrote one, shown under a plain label. Never
 *     `internalNote`, never who recorded it, never coordinates. A place name
 *     only where the carrier's own feed supplied it (a hub name) - a label a
 *     driver typed on their phone is not repeated.
 *   - **What is wrong, if anything.** An open exception becomes a CATEGORY -
 *     "held at customs or at the port", "delayed" - and nothing of what the
 *     carrier wrote about it. SLA-risk and "unrecognised carrier code"
 *     exceptions are the operator's own bookkeeping and are never shown.
 *   - **The ETA.** The carrier's or the exception's revised estimate where one
 *     exists, else the carrier's service promise, else plainly none.
 *   - **Proof of delivery**, once delivered: when, who took it, whether a
 *     delivery code was read back, and whether a signature or photograph was
 *     captured. The images themselves only through a single-use link that
 *     works for a few minutes, for the person who asked for it, re-checked
 *     against the order when it is redeemed.
 *
 * WHAT THE SELLER GETS
 *
 * The same ETA and the same proof-of-delivery summary, with the recipient's
 * name reduced to "Given F." by `maskPersonName`, and without the images. The
 * signature is the handwriting of somebody on the BUYER's premises and the
 * photograph shows the buyer's door; the seller is told they exist, and a
 * dispute about them goes through the marketplace, which can see them.
 */
import type {
  LogisticsEventSource,
  LogisticsExceptionType,
  LogisticsShipmentStatus,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import { maskPersonName } from '../../domain/logistics-masking.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { isServable } from './document.service.js';

// ---------------------------------------------------------------------------
// What a buyer may be told
// ---------------------------------------------------------------------------

/**
 * The trouble a buyer is told about, in categories rather than words.
 *
 * "Port" and "customs" are one category: to a buyer waiting for a pallet they
 * are the same wait, and the carrier's own feeds do not reliably tell them
 * apart.
 */
export type BuyerTroubleCategory =
  | 'CUSTOMS'
  | 'DELAY'
  | 'ADDRESS'
  | 'MISSED_DELIVERY'
  | 'DAMAGE'
  | 'LOST'
  | 'TEMPERATURE';

/** Statuses that are themselves a problem, and what the buyer calls each. */
const TROUBLE_BY_STATUS: Readonly<Partial<Record<LogisticsShipmentStatus, BuyerTroubleCategory>>> =
  Object.freeze({
    CUSTOMS_HOLD: 'CUSTOMS',
    DELAYED: 'DELAY',
    ON_HOLD: 'DELAY',
    ADDRESS_ISSUE: 'ADDRESS',
    DELIVERY_ATTEMPTED: 'MISSED_DELIVERY',
    DELIVERY_FAILED: 'MISSED_DELIVERY',
    DAMAGED: 'DAMAGE',
    LOST: 'LOST',
    TEMPERATURE_EXCEPTION: 'TEMPERATURE',
  });

/**
 * Exception types a buyer is told about.
 *
 * Absent on purpose: SLA_RISK and SLA_BREACH (the carrier's contract clock,
 * the operator's business), UNMAPPED_EXTERNAL_EVENT (a code nobody has read
 * yet - telling the buyer "something happened" helps nobody), and
 * PACKAGE_NOT_READY (between the seller and their carrier, before the parcel
 * is the buyer's concern).
 */
const TROUBLE_BY_EXCEPTION: Readonly<Partial<Record<LogisticsExceptionType, BuyerTroubleCategory>>> =
  Object.freeze({
    CUSTOMS_DELAY: 'CUSTOMS',
    DOCUMENTATION_MISSING: 'CUSTOMS',
    WEATHER_DELAY: 'DELAY',
    VEHICLE_BREAKDOWN: 'DELAY',
    PICKUP_MISSED: 'DELAY',
    ADDRESS_INCORRECT: 'ADDRESS',
    RECIPIENT_UNAVAILABLE: 'MISSED_DELIVERY',
    DELIVERY_ATTEMPT_FAILED: 'MISSED_DELIVERY',
    PRODUCT_DAMAGED: 'DAMAGE',
    PACKAGE_LOST: 'LOST',
    TEMPERATURE_EXCURSION: 'TEMPERATURE',
  });

/**
 * Movement a buyer is shown even when nobody wrote a sentence for it.
 *
 * The rungs before collection (assigned, accepted, offered) are left out
 * unless somebody wrote the buyer a line: they are the negotiation between a
 * seller and a carrier, and a buyer shown "Assigned", "Rejected", "Assigned"
 * has been shown a refusal the order page deliberately coarsens away.
 */
const MILESTONES: ReadonlySet<LogisticsShipmentStatus> = new Set<LogisticsShipmentStatus>([
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'CANCELLED',
]);

/** Where an event's place name may be trusted as a carrier's own hub name. */
const CARRIER_FEED: ReadonlySet<LogisticsEventSource> = new Set<LogisticsEventSource>([
  'CARRIER_API',
  'INBOUND_WEBHOOK',
]);

/** Past these, a consignment has no ETA to give. */
const FINISHED: ReadonlySet<LogisticsShipmentStatus> = new Set<LogisticsShipmentStatus>([
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'LOST',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
]);

const OPEN_EXCEPTION_STATES = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'] as const;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface BuyerTrackingEvent {
  status: LogisticsShipmentStatus;
  /** MILESTONE for movement, TROUBLE for a problem, CORRECTION for a fix. */
  kind: 'MILESTONE' | 'TROUBLE' | 'CORRECTION';
  trouble: BuyerTroubleCategory | null;
  /** The sentence written for the buyer, or null - then the label is shown. */
  description: string | null;
  occurredAt: string;
  /** A carrier hub's name, from the carrier's own feed only. */
  location: string | null;
}

export interface TrackingEta {
  /** ESTIMATE: the carrier's or a revised estimate. PROMISE: the service window. */
  source: 'ESTIMATE' | 'REVISED' | 'PROMISE' | 'NONE' | 'FINISHED';
  at: string | null;
  /** The date has passed and the parcel is still not there. */
  isLate: boolean;
}

export interface TrackingProofOfDelivery {
  deliveredAt: string;
  /** Full to the buyer, "Given F." to the seller, null where nobody gave one. */
  receivedBy: string | null;
  receivedByRole: string | null;
  confirmedWithCode: boolean;
  businessStamped: boolean;
  signature: { captured: boolean; available: boolean };
  photo: { captured: boolean; available: boolean };
}

export interface BuyerConsignmentTracking {
  id: string;
  reference: string;
  status: LogisticsShipmentStatus;
  events: BuyerTrackingEvent[];
  openTrouble: { category: BuyerTroubleCategory; since: string }[];
  eta: TrackingEta;
  proofOfDelivery: TrackingProofOfDelivery | null;
  /**
   * True when the parcel is DELIVERED but no proof was recorded here - a
   * consignment the seller marked delivered from their own carrier's word.
   * Said rather than left blank, so an empty section is not read as a fault.
   */
  deliveredWithoutProof: boolean;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The order-ownership filter, exactly as `orderScopeWhere` returns it. */
export interface OrderScope {
  customerProfileId?: string;
  buyerCompanyId: string | null;
}

const consignmentSelect = {
  id: true,
  shipmentReference: true,
  status: true,
  estimatedDeliveryAt: true,
  deliveryDueAt: true,
  deliveredAt: true,
  events: {
    orderBy: { occurredAt: 'asc' as const },
    // The internal note, the actor and the coordinates are NOT here, and that
    // is the control: nothing below can leak a column this never read.
    select: {
      status: true,
      publicDescription: true,
      occurredAt: true,
      source: true,
      locationLabel: true,
      isCorrection: true,
    },
  },
  exceptions: {
    where: { state: { in: [...OPEN_EXCEPTION_STATES] } },
    orderBy: { createdAt: 'asc' as const },
    // The type, when, and the revised promise. Never `reason`, `detail`,
    // `resolutionNotes` or the carrier's payload - those are the carrier's
    // words about its own work.
    select: { type: true, createdAt: true, revisedEtaAt: true },
  },
  proofOfDelivery: {
    select: {
      deliveredAt: true,
      recipientName: true,
      recipientDesignation: true,
      otpVerified: true,
      businessStamped: true,
      hasSignature: true,
      hasPhoto: true,
      signatureDocumentId: true,
      photoDocumentId: true,
    },
  },
} satisfies Prisma.LogisticsShipmentSelect;

type ConsignmentRow = Prisma.LogisticsShipmentGetPayload<{ select: typeof consignmentSelect }>;

/**
 * Every consignment on one of the buyer's orders, with its timeline, trouble,
 * ETA and proof of delivery.
 *
 * Ownership is the `where` clause on the ORDER, the same filter the order page
 * itself uses: somebody else's order is not found, and its consignments are
 * never loaded.
 */
export async function readBuyerTracking(
  scope: OrderScope,
  orderId: string,
  now: Date = new Date(),
): Promise<{ consignments: BuyerConsignmentTracking[] }> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...scope },
    select: { id: true },
  });
  if (order === null) throw notFound('Order');

  const rows = await prisma.logisticsShipment.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: 'asc' },
    select: consignmentSelect,
  });

  const servable = await servableDocumentIds(rows);

  return {
    consignments: rows.map((row) => ({
      id: row.id,
      reference: row.shipmentReference,
      status: row.status,
      events: buyerEvents(row.events),
      openTrouble: openTrouble(row),
      eta: etaOf(row, now),
      proofOfDelivery: podSummary(row, 'BUYER', servable),
      deliveredWithoutProof: row.status === 'DELIVERED' && row.proofOfDelivery === null,
    })),
  };
}

/** The ETA and proof-of-delivery summary for one consignment, for its seller. */
export async function readSellerDeliverySummary(
  shipmentId: string,
  now: Date = new Date(),
): Promise<{ eta: TrackingEta; proofOfDelivery: TrackingProofOfDelivery | null; deliveredWithoutProof: boolean }> {
  const row = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: consignmentSelect,
  });
  if (row === null) throw notFound('Consignment');

  const servable = await servableDocumentIds([row]);

  return {
    eta: etaOf(row, now),
    proofOfDelivery: podSummary(row, 'SELLER', servable),
    deliveredWithoutProof: row.status === 'DELIVERED' && row.proofOfDelivery === null,
  };
}

function buyerEvents(events: ConsignmentRow['events']): BuyerTrackingEvent[] {
  return events
    .filter(
      (event) =>
        event.publicDescription !== null ||
        MILESTONES.has(event.status) ||
        TROUBLE_BY_STATUS[event.status] !== undefined,
    )
    .map((event) => {
      const trouble = TROUBLE_BY_STATUS[event.status] ?? null;
      return {
        status: event.status,
        kind: event.isCorrection ? 'CORRECTION' : trouble !== null ? 'TROUBLE' : 'MILESTONE',
        trouble,
        description: event.publicDescription,
        occurredAt: event.occurredAt.toISOString(),
        location: CARRIER_FEED.has(event.source) ? event.locationLabel : null,
      };
    });
}

/**
 * What is wrong now, once per category.
 *
 * From two places, because they are recorded separately: the consignment's
 * own status (the carrier scanned it "held at customs") and an open
 * exception (somebody raised a customs delay while it still reads "in
 * transit"). A finished consignment has nothing wrong with it any more.
 */
function openTrouble(row: ConsignmentRow): { category: BuyerTroubleCategory; since: string }[] {
  if (row.status === 'DELIVERED' || row.status === 'CANCELLED') return [];

  const found = new Map<BuyerTroubleCategory, Date>();

  const statusTrouble = TROUBLE_BY_STATUS[row.status];
  if (statusTrouble !== undefined) {
    const lastEvent = [...row.events].reverse().find((event) => event.status === row.status);
    found.set(statusTrouble, lastEvent?.occurredAt ?? new Date(0));
  }

  for (const exception of row.exceptions) {
    const category = TROUBLE_BY_EXCEPTION[exception.type];
    if (category === undefined || found.has(category)) continue;
    found.set(category, exception.createdAt);
  }

  return [...found.entries()].map(([category, since]) => ({ category, since: since.toISOString() }));
}

/**
 * The best date there is, and which kind of date it is.
 *
 * Three sources in order of how much they know: an estimate (the carrier's,
 * or one revised on an exception, which `exception.service.ts` writes onto
 * the consignment), then the promise worked out from the carrier's service
 * hours, then nothing - and "nothing" is returned as NONE rather than as a
 * null the screen might render as an empty date.
 */
export function etaOf(
  row: Pick<ConsignmentRow, 'status' | 'estimatedDeliveryAt' | 'deliveryDueAt' | 'exceptions'>,
  now: Date,
): TrackingEta {
  if (FINISHED.has(row.status)) return { source: 'FINISHED', at: null, isLate: false };

  const late = (at: Date): boolean => at.getTime() < now.getTime();

  if (row.estimatedDeliveryAt !== null) {
    const revised = row.exceptions.some(
      (exception) =>
        exception.revisedEtaAt !== null &&
        exception.revisedEtaAt.getTime() === row.estimatedDeliveryAt?.getTime(),
    );
    return {
      source: revised ? 'REVISED' : 'ESTIMATE',
      at: row.estimatedDeliveryAt.toISOString(),
      isLate: late(row.estimatedDeliveryAt),
    };
  }

  if (row.deliveryDueAt !== null) {
    return { source: 'PROMISE', at: row.deliveryDueAt.toISOString(), isLate: late(row.deliveryDueAt) };
  }

  return { source: 'NONE', at: null, isLate: false };
}

function podSummary(
  row: ConsignmentRow,
  audience: 'BUYER' | 'SELLER',
  servable: ReadonlySet<string>,
): TrackingProofOfDelivery | null {
  const pod = row.proofOfDelivery;
  if (pod === null) return null;

  return {
    deliveredAt: pod.deliveredAt.toISOString(),
    receivedBy: audience === 'BUYER' ? pod.recipientName : maskPersonName(pod.recipientName),
    receivedByRole: pod.recipientDesignation,
    confirmedWithCode: pod.otpVerified,
    businessStamped: pod.businessStamped,
    signature: {
      captured: pod.hasSignature,
      available:
        audience === 'BUYER' && pod.signatureDocumentId !== null && servable.has(pod.signatureDocumentId),
    },
    photo: {
      captured: pod.hasPhoto,
      available: audience === 'BUYER' && pod.photoDocumentId !== null && servable.has(pod.photoDocumentId),
    },
  };
}

/** Which of these consignments' POD images exist and may be handed over. */
async function servableDocumentIds(rows: ConsignmentRow[]): Promise<Set<string>> {
  const ids = rows.flatMap((row) =>
    [row.proofOfDelivery?.signatureDocumentId, row.proofOfDelivery?.photoDocumentId].filter(
      (id): id is string => typeof id === 'string',
    ),
  );
  if (ids.length === 0) return new Set();

  const documents = await prisma.logisticsShipmentDocument.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, scanState: true },
  });

  return new Set(documents.filter((document) => isServable(document.scanState)).map((document) => document.id));
}

// ---------------------------------------------------------------------------
// The proof-of-delivery images
// ---------------------------------------------------------------------------

export type PodImageKind = 'signature' | 'photo';

/**
 * The document behind one of the POD's images, if the caller may have it.
 *
 * Every check is in the query: the order must be the caller's (same scope as
 * the order page), the consignment must be on that order, and the document
 * must be the one the POD row points at - not any other file on the
 * consignment, and not a damage photograph a carrier attached for the
 * marketplace. Anything else is "not found", never "forbidden", so a guessed
 * id learns nothing.
 */
async function locatePodImage(
  scope: OrderScope,
  orderId: string,
  shipmentId: string,
  kind: PodImageKind,
): Promise<{ id: string; storageKey: string; contentType: string; fileName: string; scanState: string }> {
  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, order: { id: orderId, ...scope } },
    select: {
      proofOfDelivery: { select: { signatureDocumentId: true, photoDocumentId: true } },
    },
  });

  const documentId =
    kind === 'signature'
      ? shipment?.proofOfDelivery?.signatureDocumentId
      : shipment?.proofOfDelivery?.photoDocumentId;

  if (documentId === undefined || documentId === null) throw notFound('Proof of delivery');

  const document = await prisma.logisticsShipmentDocument.findFirst({
    where: { id: documentId, shipmentId, deletedAt: null },
    select: { id: true, storageKey: true, contentType: true, fileName: true, scanState: true },
  });

  if (document === null) throw notFound('Proof of delivery');
  return document;
}

function tokenHash(documentId: string, userId: string, token: string): string {
  // The document AND the person are bound into the hash, and the prefix is
  // this feature's own, so a token cannot redeem another file, cannot be
  // redeemed by anybody else, and cannot be spent on any other link route.
  return sha256Hex(`buyer-pod-image:${documentId}:${userId}:${token}`);
}

/**
 * A link to one proof-of-delivery image that works once, for a few minutes,
 * for the person who asked for it.
 *
 * The same shape as every other private file in this system - 32 random
 * bytes, only the hash stored on `auth_tokens`, the TTL the operator set in
 * `LOGISTICS_DOCUMENT_URL_TTL_SECONDS`.
 */
export async function createBuyerPodLink(input: {
  scope: OrderScope;
  userId: string;
  orderId: string;
  shipmentId: string;
  kind: PodImageKind;
}): Promise<{ url: string; expiresAt: string }> {
  const document = await locatePodImage(input.scope, input.orderId, input.shipmentId, input.kind);

  if (!isServable(document.scanState as Parameters<typeof isServable>[0])) {
    throw conflict(
      ErrorCode.SELLER_DOCUMENT_REJECTED,
      'This installation does not hand out files that have not been scanned for malware.',
      [{ code: 'SCAN_STATE', meta: { scanState: document.scanState } }],
    );
  }

  const { token } = generateToken(32);
  const expiresAt = new Date(Date.now() + env.LOGISTICS_DOCUMENT_URL_TTL_SECONDS * 1000);

  await prisma.authToken.create({
    data: {
      id: newId(),
      userId: input.userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: tokenHash(document.id, input.userId, token),
      expiresAt,
      createdById: input.userId,
    },
  });

  return {
    url:
      `/api/v1/orders/${input.orderId}/shipments/${input.shipmentId}` +
      `/proof-of-delivery/${input.kind}/download?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Redeem the link and hand over the bytes.
 *
 * The order is checked AGAIN - a buyer who lost access to a company's orders
 * between asking for the link and following it is refused - and the token is
 * spent with a conditional update, so two requests racing on one link hand
 * the file over once.
 */
export async function redeemBuyerPodLink(input: {
  scope: OrderScope;
  userId: string;
  orderId: string;
  shipmentId: string;
  kind: PodImageKind;
  token: string;
  correlationId: string | null;
}): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const document = await locatePodImage(input.scope, input.orderId, input.shipmentId, input.kind);

  const record = await prisma.authToken.findUnique({
    where: { tokenHash: tokenHash(document.id, input.userId, input.token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  });

  if (record === null || record.userId !== input.userId || record.expiresAt.getTime() <= Date.now()) {
    throw forbidden(ErrorCode.TOKEN_INVALID, 'This link is no longer valid. Ask for a new one.');
  }
  if (record.consumedAt !== null) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This link has already been used. Ask for a new one.');
  }
  if (!isServable(document.scanState as Parameters<typeof isServable>[0])) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  const consumed = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw forbidden(ErrorCode.TOKEN_ALREADY_USED, 'This link has already been used. Ask for a new one.');
  }

  await recordAudit({
    action: AuditAction.PROOF_OF_DELIVERY_DOWNLOADED,
    resourceType: 'logistics_shipment_document',
    resourceId: document.id,
    actorType: 'CUSTOMER',
    actorUserId: input.userId,
    after: { shipmentId: input.shipmentId, kind: input.kind },
    correlationId: input.correlationId,
  });

  return {
    body: await storage.get(document.storageKey),
    contentType: document.contentType,
    fileName: document.fileName,
  };
}
