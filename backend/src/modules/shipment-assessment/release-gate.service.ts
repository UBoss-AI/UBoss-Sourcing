/**
 * The L2 release gate.
 *
 * Asked inside the transaction of every act that would start L2 - the leg
 * moving to IN_PROGRESS (admin, Seller Hub and carrier-portal routes all go
 * through `transitionLeg`) and a person moving the consignment onward after
 * L1 (`recordShipmentEvent`, which every portal, manifest handover and admin
 * correction uses). A refusal throws before anything is written, so no
 * departure is recorded and no carrier is told anything.
 *
 * It never depends on the scheduled sweep: expiry, a changed shipment, a
 * changed badge and a suspension are all checked here, at the moment.
 *
 * A carrier feed is different. It reports what already happened; refusing it
 * would only make the record false. So a carrier-reported departure during a
 * hold is recorded as it happened and raises a ShipmentAssessmentException
 * for the Audit Team - never discarded, never treated as approval.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { releaseRefusal, ruleFor, type AssessmentStatus, type ReleaseRefusal } from '../../domain/shipment-assessment.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { activePolicy, announce, currentFingerprint, moveAssessment, writeEvent, type Client } from './context.js';

const REFUSAL_TEXT: Record<ReleaseRefusal, string> = {
  L1_NOT_COMPLETE: 'L1 has not been handed over at the port or airport of loading yet.',
  NOT_APPROVED: 'The shipment has not been released by the Audit Team.',
  NO_AUTHORIZATION: 'The shipment has no active release authorization.',
  AUTHORIZATION_EXPIRED: 'The release authorization passed its dispatch deadline. The Audit Team must review the shipment again.',
  SHIPMENT_CHANGED: 'The shipment changed after it was released (lines, quantities, packing list or destination). It must be reviewed again.',
  BADGE_CHANGED: "The seller's Audit badge changed after the waiver. The waiver no longer applies.",
  SELLER_SUSPENDED: 'The seller is suspended.',
  LOADING_CHECKS_PENDING: 'The final loading checks have not all been recorded as passed.',
};

/** The facts and the verdict for one assessment, as of now. */
export async function releaseCheck(client: Client, assessmentId: string) {
  const assessment = await client.shipmentAssessment.findUniqueOrThrow({
    where: { id: assessmentId },
    include: {
      releases: { where: { status: 'ACTIVE' }, take: 1 },
      sellerAccount: { select: { auditBadge: true, auditBadgeVersion: true, status: true } },
    },
  });
  const auth = assessment.releases[0] ?? null;
  const policy = await activePolicy(client);
  const fingerprint = await currentFingerprint(client, assessment.sellerOrderGroupId);
  const refusal = releaseRefusal({
    now: new Date(),
    l1Complete: assessment.l1CompletedAt !== null,
    status: assessment.status,
    authorization: auth,
    currentFingerprint: fingerprint,
    currentBadgeVersion: assessment.sellerAccount.auditBadgeVersion,
    waiverStillEligible: ruleFor(policy, assessment.sellerAccount.auditBadge) !== 'ASSESSMENT_REQUIRED' && !assessment.mandatoryInspection,
    sellerSuspended: assessment.sellerAccount.status === 'SUSPENDED',
    loadingChecksPassed: assessment.loadingChecksCompletedAt !== null,
    openExceptions: 0,
  });
  return { assessment, auth, refusal, fingerprint };
}

function refuse(refusal: ReleaseRefusal): Error {
  return conflict(ErrorCode.SHIPMENT_ASSESSMENT_NOT_RELEASED, REFUSAL_TEXT[refusal], [{ field: 'shipmentAssessment', code: refusal }]);
}

/** Lock the assessment row for the rest of the transaction. */
async function lock(tx: PrismaTransaction, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM shipment_assessments WHERE id = ${id} FOR UPDATE`;
}

/**
 * L2 is starting: refuse, or consume the release. Inside the leg's
 * transaction. Two departures at once serialise on the row lock; the second
 * finds the authorization CONSUMED.
 */
export async function consumeReleaseForL2(
  tx: PrismaTransaction,
  leg: { id: string; sellerOrderGroupId: string },
  actor: { userId: string | null; role: 'SELLER' | 'UBOSS' | 'PARTNER' },
): Promise<void> {
  if (!env.FEATURE_SHIPMENT_ASSESSMENT) return;
  const found = await tx.shipmentAssessment.findUnique({ where: { sellerOrderGroupId: leg.sellerOrderGroupId }, select: { id: true } });
  // No case yet: the sweep creates one. Until then, nothing has been released.
  if (found === null) throw refuse('NO_AUTHORIZATION');
  await lock(tx, found.id);
  const { assessment, auth, refusal } = await releaseCheck(tx, found.id);
  if (refusal !== null || auth === null) throw refuse(refusal ?? 'NO_AUTHORIZATION');

  const now = new Date();
  const consumed = await tx.shipmentReleaseAuthorization.updateMany({
    where: { id: auth.id, status: 'ACTIVE', version: auth.version },
    data: { status: 'CONSUMED', activeSlot: null, consumedAt: now, consumedLegId: leg.id, version: { increment: 1 } },
  });
  if (consumed.count === 0) throw refuse('NO_AUTHORIZATION');
  await moveAssessment(tx, assessment, 'DISPATCHED', { kind: 'L2_DEPARTED', actorRole: actor.role === 'PARTNER' ? 'LOGISTICS' : actor.role === 'SELLER' ? 'SELLER' : 'AUDIT', actorUserId: actor.userId }, { dispatchedAt: now });
  // The documents become historical evidence. They release nothing again.
  await tx.auditDocument.updateMany({ where: { releaseId: auth.id, status: 'ACTIVE' }, data: { status: 'USED', statusChangedAt: now } });
  await recordAudit(
    {
      action: AuditAction.SHIPMENT_RELEASE_CONSUMED,
      resourceType: 'ShipmentAssessment',
      resourceId: assessment.id,
      actorType: actor.role === 'PARTNER' ? 'LOGISTICS' : 'SYSTEM',
      actorUserId: actor.userId,
      after: { releaseId: auth.id, legId: leg.id },
    },
    tx,
  );
}

/** Consignment statuses that mean the goods left the port of loading, once L1 is done. */
export const L2_DEPARTURE_STATUSES: readonly string[] = ['IN_TRANSIT', 'AT_DESTINATION_HUB', 'CUSTOMS_HOLD', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED'];

async function caseForConsignment(client: Client, shipmentId: string) {
  const shipment = await client.logisticsShipment.findUnique({ where: { id: shipmentId }, select: { sellerOrderGroupId: true } });
  if (shipment?.sellerOrderGroupId === null || shipment?.sellerOrderGroupId === undefined) return null;
  return client.shipmentAssessment.findUnique({ where: { sellerOrderGroupId: shipment.sellerOrderGroupId }, select: { id: true, status: true, l1CompletedAt: true } });
}

function stillBlocks(row: { status: AssessmentStatus; l1CompletedAt: Date | null } | null): boolean {
  return row !== null && row.l1CompletedAt !== null && row.status !== 'DISPATCHED' && row.status !== 'CANCELLED';
}

/**
 * A person moving a consignment onward after L1 is moving it into L2. Refused
 * unless the release would be granted right now. The leg transition is still
 * what consumes the release.
 */
export async function assertConsignmentMayDepart(tx: PrismaTransaction, shipmentId: string, to: string, actor: string): Promise<void> {
  if (!env.FEATURE_SHIPMENT_ASSESSMENT || actor === 'CARRIER' || !L2_DEPARTURE_STATUSES.includes(to)) return;
  const row = await caseForConsignment(tx, shipmentId);
  if (row === null || !stillBlocks(row)) return;
  const { refusal } = await releaseCheck(tx, row.id);
  if (refusal !== null) throw refuse(refusal);
}

/**
 * After a carrier event has been recorded: if it reports the goods leaving
 * while the shipment is not released, raise an exception. Best-effort and
 * idempotent per event.
 */
export async function noteCarrierDeparture(input: { shipmentId: string; status: string; eventId: string | null; occurredAt: Date }): Promise<void> {
  if (!env.FEATURE_SHIPMENT_ASSESSMENT || !L2_DEPARTURE_STATUSES.includes(input.status)) return;
  try {
    const row = await caseForConsignment(prisma, input.shipmentId);
    if (row === null || !stillBlocks(row) || row.l1CompletedAt === null || input.occurredAt < row.l1CompletedAt) return;
    const { refusal } = await releaseCheck(prisma, row.id);
    if (refusal === null) return;
    await prisma.$transaction(async (tx) => {
      const assessment = await tx.shipmentAssessment.findUniqueOrThrow({ where: { id: row.id } });
      await tx.shipmentAssessmentException.create({
        data: {
          id: newId(),
          assessmentId: row.id,
          kind: 'DEPARTED_DURING_HOLD',
          logisticsShipmentId: input.shipmentId,
          shipmentEventId: input.eventId,
          detail: `The carrier reported ${input.status} while the shipment was not released (${refusal}).`,
          occurredAt: input.occurredAt,
        },
      });
      await writeEvent(tx, row.id, { kind: 'DEPARTURE_EXCEPTION', actorRole: 'SYSTEM', actorUserId: null, note: `Carrier reported ${input.status} without a release (${refusal}).` });
      await recordAudit({ action: AuditAction.SHIPMENT_DEPARTURE_EXCEPTION, resourceType: 'ShipmentAssessment', resourceId: row.id, actorType: 'SYSTEM', after: { status: input.status, refusal } }, tx);
      await announce(tx, assessment, {
        kind: 'shipment_assessment.departure_exception',
        title: `${assessment.number}: carrier reported departure without release`,
        body: `The carrier reported ${input.status} while the shipment was not released. Investigate and record the outcome.`,
        seller: true,
      });
    });
  } catch (error) {
    // A duplicate event id lands on the unique index: already raised.
    logger.warn({ err: error, shipmentId: input.shipmentId }, 'shipment assessment departure exception not recorded');
  }
}
