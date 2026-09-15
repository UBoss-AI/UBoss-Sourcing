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
 * THE OTP
 *
 * Delivered to the recipient by EMAIL, because this deployment has no SMS
 * driver - the same honest compromise `users.pendingPhone` already documents.
 * That proves control of the account the order was placed from, which is what
 * stops a parcel being signed for by whoever happens to be in the corridor. It
 * does not prove control of a telephone. Wiring an SMS provider is what
 * upgrades it, and the only thing that changes is where the code is sent.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { safeCompare, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordLogisticsAudit } from './audit.service.js';
import { completeAssignmentsFor } from './assignment.service.js';
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

  const access = await assertShipmentAccess(membership, input.shipmentId, 'WRITE');

  const existing = await prisma.logisticsProofOfDelivery.findUnique({
    where: { shipmentId: access.shipmentId },
    select: { id: true },
  });

  if (existing !== null) {
    return { podId: existing.id, status: access.status, duplicate: true };
  }

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

  let otpVerified = false;

  if (policy.requiresOtp) {
    otpVerified = await consumeDeliveryOtp(access.shipmentId, input.otp ?? '');
    if (!otpVerified) {
      throw conflict(
        ErrorCode.SHIPMENT_OTP_INVALID,
        'That delivery code is not right, or it has expired. Ask the recipient for the current one.',
      );
    }
  }

  // Both documents must belong to THIS consignment. A driver supplying a
  // signature id from another delivery would otherwise attach somebody else's
  // handwriting as proof of this one.
  await assertDocumentsBelong(access.shipmentId, [
    input.signatureDocumentId,
    input.photoDocumentId,
  ]);

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
 * Six digits, valid for the delivery window.
 *
 * Stored as a SHA-256 on the shared `AuthToken` table, scoped to the
 * consignment. Reusing that table rather than adding a sixth token store means
 * the existing expiry sweep and single-use enforcement apply for free.
 *
 * The recipient's own user account is the subject, so the code is delivered to
 * the address the order was placed from - see the note at the top of this file
 * about what that does and does not prove.
 */
const OTP_TTL_MINUTES = 240;

function otpHash(shipmentId: string, code: string): string {
  return sha256Hex(`logistics-pod-otp:${shipmentId}:${code}`);
}

export async function issueDeliveryOtp(shipmentId: string): Promise<{ code: string } | null> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { receivingCustomerProfileId: true },
  });

  /*
   * Two reads rather than a join, and the reason is the schema.
   *
   * `receivingCustomerProfileId` is stored as a bare id with no Prisma
   * relation, deliberately: it is the OPERATOR's link back to the buyer and is
   * never selected on a path a carrier can reach. Declaring a relation would
   * put `shipment.receivingCustomerProfile` one autocomplete away from every
   * query in the logistics module, and the first person who used it would ship
   * a buyer's account to a courier.
   */
  const profileId = shipment?.receivingCustomerProfileId ?? null;
  if (profileId === null) return null;

  const profile = await prisma.customerProfile.findUnique({
    where: { id: profileId },
    select: { userId: true },
  });

  // No account behind the consignment means nowhere to send a code - a manual
  // movement, or an order imported without a buyer. The caller's policy check
  // then refuses the delivery rather than accepting an unverified one, which
  // is the safe direction.
  const userId = profile?.userId ?? null;
  if (userId === null) return null;

  // Six digits, uniformly distributed. `Math.random` is deliberately not used:
  // this is a credential, however short-lived.
  const code = String(100000 + (cryptoInt() % 900000));

  await prisma.authToken.create({
    data: {
      id: newId(),
      userId,
      type: 'EMAIL_VERIFICATION',
      tokenHash: otpHash(shipmentId, code),
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
    },
  });

  return { code };
}

function cryptoInt(): number {
  // A single unsigned 32-bit draw, which is plenty for six digits and avoids
  // pulling in a second random source.
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
}

/**
 * Check the code the recipient read out, and spend it.
 *
 * Constant-time comparison of the HASHES rather than of the codes, and a
 * conditional update to spend it, so two drivers racing the same code produce
 * one accepted delivery. Returns false rather than throwing, because the
 * caller turns it into a POD-shaped refusal with the right wording.
 */
async function consumeDeliveryOtp(shipmentId: string, supplied: string): Promise<boolean> {
  const digits = supplied.replace(/\D/g, '');
  if (digits.length !== 6) return false;

  const hash = otpHash(shipmentId, digits);

  const record = await prisma.authToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, tokenHash: true, expiresAt: true, consumedAt: true },
  });

  if (
    record === null ||
    record.consumedAt !== null ||
    record.expiresAt.getTime() <= Date.now() ||
    !safeCompare(record.tokenHash, hash)
  ) {
    return false;
  }

  const spent = await prisma.authToken.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return spent.count === 1;
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
