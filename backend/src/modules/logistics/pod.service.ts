/**
 * Proof of Delivery.
 *
 * What counts as proof is the DEPLOYMENT's decision, not this software's. A
 * pharmacy wants a signature and a named recipient; a hospital loading bay
 * wants a photograph; a controlled-drugs movement wants a one-time code read
 * back by the person taking it. All three are supported and none is assumed -
 * the policy lives on `LogisticsSlaPolicy` and this file enforces whatever it
 * says.
 *
 * TWO RULES WORTH STATING PLAINLY
 *
 *  1. **The POD is captured BEFORE the status moves.** `assertShipmentTransition`
 *     refuses `-> DELIVERED` without one, so the order is not a convention: a
 *     consignment cannot be marked delivered and then have its evidence
 *     attached later, which is precisely the sequence that produces a
 *     delivered parcel nobody signed for.
 *
 *  2. **The signature image is never in a response body.** It is a
 *     `LogisticsShipmentDocument` under the private prefix, and this row points
 *     at it. A signature inline in JSON is a signature in a browser cache, in
 *     a proxy log and in anybody's developer tools.
 *
 * THE DELIVERY CODE (OTP)
 *
 * Sent to the BUYER by email - automatically when the consignment goes out for
 * delivery, and again on request from the portal - and read out by them at the
 * door. Issuing, limits and checking all live in `delivery-code.service.ts`;
 * this file only asks it whether the code the driver typed is the live one,
 * and asks it to send a new one. See that file for what an emailed code does
 * and does not prove.
 */
import { AppError, ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordLogisticsAudit } from './audit.service.js';
import { completeAssignmentsFor } from './assignment.service.js';
import {
  checkAndSpendDeliveryCode,
  readDeliveryCodeState,
  sendDeliveryCode,
  type DeliveryCodeState,
} from './delivery-code.service.js';
import { recordShipmentEvent } from './shipment-event.service.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

export interface PodPolicy {
  requiresRecipientName: boolean;
  requiresSignature: boolean;
  requiresPhoto: boolean;
  requiresOtp: boolean;
  requiresDesignation: boolean;
}

const DEFAULT_POLICY: PodPolicy = Object.freeze({
  // A name and nothing else, for a deployment that has configured no policy.
  // The mildest useful proof: somebody was there and gave their name.
  requiresRecipientName: true,
  requiresSignature: false,
  requiresPhoto: false,
  requiresOtp: false,
  requiresDesignation: false,
});

export async function readPodPolicy(shipmentId: string): Promise<PodPolicy> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      slaPolicy: {
        select: {
          podRequiresRecipientName: true,
          podRequiresSignature: true,
          podRequiresPhoto: true,
          podRequiresOtp: true,
          podRequiresDesignation: true,
        },
      },
    },
  });

  const policy = shipment?.slaPolicy;
  if ((policy === undefined || policy === null)) return DEFAULT_POLICY;

  return {
    requiresRecipientName: policy.podRequiresRecipientName,
    requiresSignature: policy.podRequiresSignature,
    requiresPhoto: policy.podRequiresPhoto,
    requiresOtp: policy.podRequiresOtp,
    requiresDesignation: policy.podRequiresDesignation,
  };
}

export interface CapturePodInput {
  shipmentId: string;
  recipientName?: string | null;
  recipientDesignation?: string | null;
  deliveredAt?: Date | null;
  latitude?: number | null;
  longitude?: number | null;
  locationLabel?: string | null;
  /** Document ids already uploaded through `document.service.ts`. */
  signatureDocumentId?: string | null;
  photoDocumentId?: string | null;
  businessStamped?: boolean;
  /** The code the recipient read out, where the policy demands one. */
  otp?: string | null;
  exceptionNote?: string | null;
  /** The key the driver's phone retried under. */
  idempotencyKey?: string | null;
}

export interface CapturedPod {
  podId: string;
  status: ShipmentStatusName;
  duplicate: boolean;
}

/**
 * Capture the proof and mark the consignment delivered.
 *
 * One POD per consignment, which is why `shipmentId` is UNIQUE on the table: a
 * parcel is delivered once, and a second capture is a correction rather than
 * an addition. Corrections go on the event timeline where they can be READ as
 * corrections.
 *
 * A second call returns the existing POD rather than failing - a driver's
 * phone retrying on a flaky connection must not be told the delivery failed
 * when it did not.
 */
export async function captureProofOfDelivery(
  membership: LogisticsMembership,
  input: CapturePodInput,
  correlationId?: string | null,
): Promise<CapturedPod> {
  assertLogisticsPermission(membership, LogisticsPermission.POD_WRITE);

  // The duplicate check comes BEFORE write access, and it is still tenant
  // scoped (READ loads only this carrier's own shipments). A successful
  // capture completes the assignment, so write access ends at the very moment
  // the proof is recorded; checked the other way round, the phone that retries
  // after a lost response was told "no longer assigned to your company" - that
  // the delivery it had just completed had failed.
  const seen = await assertShipmentAccess(membership, input.shipmentId, 'READ');

  const existing = await prisma.logisticsProofOfDelivery.findUnique({
    where: { shipmentId: seen.shipmentId },
    select: { id: true },
  });

  if (existing !== null) {
    return { podId: existing.id, status: seen.status, duplicate: true };
  }

  const access = await assertShipmentAccess(membership, input.shipmentId, 'WRITE');

  const policy = await readPodPolicy(access.shipmentId);
  const failures: { field: string; code: string }[] = [];

  const recipientName = input.recipientName?.trim() ?? '';
  if (policy.requiresRecipientName && recipientName.length < 2) {
    failures.push({ field: 'recipientName', code: 'REQUIRED' });
  }
  if (policy.requiresDesignation && (input.recipientDesignation ?? '').trim().length < 2) {
    failures.push({ field: 'recipientDesignation', code: 'REQUIRED' });
  }
  if (policy.requiresSignature && (input.signatureDocumentId === undefined || input.signatureDocumentId === null)) {
    failures.push({ field: 'signatureDocumentId', code: 'REQUIRED' });
  }
  if (policy.requiresPhoto && (input.photoDocumentId === undefined || input.photoDocumentId === null)) {
    failures.push({ field: 'photoDocumentId', code: 'REQUIRED' });
  }

  if (failures.length > 0) {
    throw badRequest(
      ErrorCode.SHIPMENT_POD_REQUIRED,
      'This delivery needs more proof before it can be completed.',
      failures,
    );
  }

  // Both documents must belong to THIS consignment. A driver supplying a
  // signature id from another delivery would otherwise attach somebody else's
  // handwriting as proof of this one. Checked BEFORE the code is spent: a
  // refusal here must not burn the code the recipient just read out.
  await assertDocumentsBelong(access.shipmentId, [
    input.signatureDocumentId,
    input.photoDocumentId,
  ]);

  let otpVerified = false;

  if (policy.requiresOtp) {
    const check = await checkAndSpendDeliveryCode(access.shipmentId, input.otp);
    if (check !== 'OK') {
      throw conflict(
        ErrorCode.SHIPMENT_OTP_INVALID,
        check === 'NOT_SENT' || check === 'TOO_MANY_ATTEMPTS' || check === 'EXPIRED'
          ? 'That delivery code can no longer be used. Send the recipient a new one.'
          : 'That delivery code is not right, or it has expired. Ask the recipient for the current one.',
        [{ field: 'otp', code: check }],
      );
    }
    otpVerified = true;
  }

  const podId = newId();
  const deliveredAt = input.deliveredAt ?? new Date();

  await prisma.logisticsProofOfDelivery.create({
    data: {
      id: podId,
      shipmentId: access.shipmentId,
      recipientName: recipientName.length > 0 ? recipientName.slice(0, 160) : null,
      recipientDesignation: input.recipientDesignation?.slice(0, 120) ?? null,
      deliveredAt,
      deliveryLatitude: input.latitude ?? null,
      deliveryLongitude: input.longitude ?? null,
      deliveryLocationLabel: input.locationLabel ?? null,
      // Facts rather than inferences. A policy tightened next year must not
      // retroactively invalidate last year's deliveries, which it would if
      // these were derived from the current policy at read time.
      hasSignature: (input.signatureDocumentId !== undefined && input.signatureDocumentId !== null),
      hasPhoto: (input.photoDocumentId !== undefined && input.photoDocumentId !== null),
      otpVerified,
      businessStamped: input.businessStamped === true,
      signatureDocumentId: input.signatureDocumentId ?? null,
      photoDocumentId: input.photoDocumentId ?? null,
      exceptionNote: input.exceptionNote?.slice(0, 512) ?? null,
      capturedByPartnerUserId: membership.partnerUserId,
      capturedBySource: membership.driverProfileId !== null ? 'DRIVER_APP' : 'LOGISTICS_PORTAL',
    },
  });

  const event = await recordShipmentEvent({
    shipmentId: access.shipmentId,
    status: 'DELIVERED',
    actor: membership.driverProfileId !== null ? 'DRIVER' : 'PARTNER',
    source: membership.driverProfileId !== null ? 'DRIVER_APP' : 'LOGISTICS_PORTAL',
    actorUserId: membership.userId,
    actorLogisticsPartnerId: membership.logisticsPartnerId,
    actorLabel: membership.fullName,
    permissions: [...membership.permissions],
    publicDescription: 'Your order has been delivered.',
    occurredAt: deliveredAt,
    locationLabel: input.locationLabel ?? null,
    locationLatitude: input.latitude ?? null,
    locationLongitude: input.longitude ?? null,
    hasProofOfDelivery: true,
    documentId: input.signatureDocumentId ?? input.photoDocumentId ?? null,
    idempotencyKey: input.idempotencyKey ?? `pod:${podId}`,
    correlationId,
  });

  // The carrier's job is done. The assignment stays as the record of who
  // carried it, and becoming COMPLETED is what turns their access read-only.
  await completeAssignmentsFor(access.shipmentId);

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.pod.captured',
    resourceType: 'logistics_proof_of_delivery',
    resourceId: podId,
    // The recipient's NAME is not written into the audit row. It is on the POD
    // where it belongs; repeating it here would put a third party's name into
    // a trail with a two-year retention window for no operational gain.
    after: {
      hasSignature: (input.signatureDocumentId !== undefined && input.signatureDocumentId !== null),
      hasPhoto: (input.photoDocumentId !== undefined && input.photoDocumentId !== null),
      otpVerified,
    },
    summary: 'Proof of delivery was captured.',
    correlationId: correlationId ?? null,
  });

  return { podId, status: event.status, duplicate: event.duplicate };
}

/**
 * Both documents, if supplied, are on this consignment.
 *
 * Checked in one query rather than two, and the count is what is compared:
 * asking for two ids and receiving one means one of them was somebody else's.
 */
async function assertDocumentsBelong(
  shipmentId: string,
  ids: (string | null | undefined)[],
): Promise<void> {
  const wanted = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (wanted.length === 0) return;

  const found = await prisma.logisticsShipmentDocument.count({
    where: { id: { in: wanted }, shipmentId, deletedAt: null },
  });

  if (found !== wanted.length) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'One of those files is not attached to this shipment.',
      [{ field: 'signatureDocumentId', code: 'NOT_ON_SHIPMENT' }],
    );
  }
}

// ---------------------------------------------------------------------------
// The delivery code
// ---------------------------------------------------------------------------

/**
 * Send the recipient a new delivery code, from the portal.
 *
 * For the driver at the door whose recipient cannot find the email, or whose
 * code expired or was killed by wrong guesses. Refused unless:
 *
 *   - the caller may capture a proof of delivery (the same key that uses the
 *     code), and has WRITE access to the consignment - for a driver, that
 *     means it is on their own live round;
 *   - the consignment is out for delivery, or a delivery was attempted - the
 *     two statuses from which DELIVERED is reachable;
 *   - its policy asks for a code at all, and there is somebody to send it to;
 *   - the limits in `delivery-code.service.ts` allow another one.
 *
 * The response says when the code was sent and when it stops working. It
 * never contains the code or where it went.
 */
export async function requestDeliveryCode(
  membership: LogisticsMembership,
  shipmentId: string,
  correlationId?: string | null,
): Promise<{ sentAt: Date; expiresAt: Date; deliveryCode: DeliveryCodeState }> {
  assertLogisticsPermission(membership, LogisticsPermission.POD_WRITE);

  const access = await assertShipmentAccess(membership, shipmentId, 'WRITE');

  if (access.status !== 'OUT_FOR_DELIVERY' && access.status !== 'DELIVERY_ATTEMPTED') {
    throw conflict(
      ErrorCode.SHIPMENT_OTP_UNAVAILABLE,
      'A delivery code can only be sent while the shipment is out for delivery.',
      [{ code: 'NOT_OUT_FOR_DELIVERY', meta: { status: access.status } }],
    );
  }

  const result = await sendDeliveryCode(access.shipmentId, {
    origin: 'REQUESTED',
    requestedBy: { userId: membership.userId, label: membership.fullName },
    correlationId: correlationId ?? null,
  });

  switch (result.kind) {
    case 'SENT':
      return {
        sentAt: result.sentAt,
        expiresAt: result.expiresAt,
        deliveryCode: await readDeliveryCodeState(access.shipmentId),
      };
    case 'NOT_REQUIRED':
      throw conflict(
        ErrorCode.SHIPMENT_OTP_UNAVAILABLE,
        'This delivery does not need a delivery code.',
        [{ code: 'NOT_REQUIRED' }],
      );
    case 'NO_RECIPIENT':
      throw conflict(
        ErrorCode.SHIPMENT_OTP_UNAVAILABLE,
        'There is no account to send a delivery code to, so this delivery cannot be completed here.',
        [{ code: 'NO_RECIPIENT' }],
      );
    case 'TOO_SOON':
      throw new AppError({
        statusCode: 429,
        code: ErrorCode.SHIPMENT_OTP_RESEND_LIMITED,
        message: 'A code was sent a moment ago. Wait a minute before sending another.',
        details: [{ code: 'TOO_SOON', meta: { retryAt: result.retryAt.toISOString() } }],
      });
    case 'DAILY_LIMIT_REACHED':
      throw new AppError({
        statusCode: 429,
        code: ErrorCode.SHIPMENT_OTP_RESEND_LIMITED,
        message: 'No more delivery codes can be sent for this shipment today.',
        details: [{ code: 'DAILY_LIMIT_REACHED' }],
      });
  }
}

/**
 * What the portal may know about this consignment's code, or null where its
 * policy asks for none. Takes a shipment id the caller has already authorised.
 */
export async function readDeliveryCodeFor(
  shipmentId: string,
  policy: PodPolicy,
): Promise<DeliveryCodeState | null> {
  return policy.requiresOtp ? readDeliveryCodeState(shipmentId) : null;
}

export interface PodView {
  id: string;
  recipientName: string | null;
  recipientDesignation: string | null;
  deliveredAt: Date;
  deliveryLocationLabel: string | null;
  hasSignature: boolean;
  hasPhoto: boolean;
  otpVerified: boolean;
  businessStamped: boolean;
  signatureDocumentId: string | null;
  photoDocumentId: string | null;
  exceptionNote: string | null;
  capturedBy: string | null;
}

/**
 * Read the proof back.
 *
 * Returns document IDS, never bytes and never URLs. The portal asks for a
 * short-lived signed link separately, which is what keeps a signature out of
 * every cache between here and a browser.
 */
export async function readProofOfDelivery(
  membership: LogisticsMembership,
  shipmentId: string,
): Promise<PodView | null> {
  const access = await assertShipmentAccess(membership, shipmentId, 'READ');

  const pod = await prisma.logisticsProofOfDelivery.findUnique({
    where: { shipmentId: access.shipmentId },
    select: {
      id: true,
      recipientName: true,
      recipientDesignation: true,
      deliveredAt: true,
      deliveryLocationLabel: true,
      hasSignature: true,
      hasPhoto: true,
      otpVerified: true,
      businessStamped: true,
      signatureDocumentId: true,
      photoDocumentId: true,
      exceptionNote: true,
      capturedByPartnerUserId: true,
    },
  });

  if (pod === null) return null;

  const capturedBy =
    pod.capturedByPartnerUserId === null
      ? null
      : (
          await prisma.logisticsPartnerUser.findFirst({
            where: {
              id: pod.capturedByPartnerUserId,
              logisticsPartnerId: membership.logisticsPartnerId,
            },
            select: { fullName: true },
          })
        )?.fullName ?? null;

  return {
    id: pod.id,
    recipientName: pod.recipientName,
    recipientDesignation: pod.recipientDesignation,
    deliveredAt: pod.deliveredAt,
    deliveryLocationLabel: pod.deliveryLocationLabel,
    hasSignature: pod.hasSignature,
    hasPhoto: pod.hasPhoto,
    otpVerified: pod.otpVerified,
    businessStamped: pod.businessStamped,
    signatureDocumentId: pod.signatureDocumentId,
    photoDocumentId: pod.photoDocumentId,
    exceptionNote: pod.exceptionNote,
    capturedBy,
  };
}

/** Used by the shipment detail route to tell the portal what the form needs. */
export async function readPodRequirements(shipmentId: string): Promise<PodPolicy> {
  return readPodPolicy(shipmentId);
}

/** Exported for the operator's review screen, which is not tenant-scoped. */
export async function podExists(shipmentId: string): Promise<boolean> {
  const found = await prisma.logisticsProofOfDelivery.findUnique({
    where: { shipmentId },
    select: { id: true },
  });

  return found !== null;
}

/** Thrown where a consignment has no POD and the caller expected one. */
export function assertPodPresent(pod: PodView | null): PodView {
  if (pod === null) throw notFound('Proof of delivery');
  return pod;
}
