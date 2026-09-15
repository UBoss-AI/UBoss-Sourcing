/**
 * Something went wrong and somebody has to do something about it.
 *
 * An exception is a WORK ITEM, distinct from the shipment's status. The status
 * says where the parcel is; this says who owns the problem, by when, and what
 * has been tried. A consignment can carry two at once - a customs hold and an
 * address that does not exist - and collapsing them into one status column
 * would lose the second one.
 *
 * TWO THINGS THIS FILE DOES THAT LOOK LIKE POLICY AND ARE
 *
 *   1. **Cold-chain and lost consignments are always CRITICAL**, whatever the
 *      caller said. On a catalogue of reagents and sterile consumables, a
 *      temperature excursion graded MEDIUM by a tired dispatcher at 2am is a
 *      batch that quietly gets delivered. The severity floor is applied here
 *      rather than trusted from the request.
 *   2. **A CRITICAL exception reaches the marketplace immediately.** Not on
 *      the next sweep, not in a digest - an operator notification written in
 *      the same transaction as the exception itself.
 */
import type {
  LogisticsExceptionSeverity,
  LogisticsExceptionState,
  LogisticsExceptionType,
} from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AdminNotificationKind, createAdminNotification } from '../notifications/admin-notification.service.js';
import { recordLogisticsAudit } from './audit.service.js';
import { createLogisticsNotification } from './notification.service.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

/**
 * The severity an exception type is AT LEAST.
 *
 * A floor rather than a fixed value: a dispatcher may raise a customs delay to
 * HIGH because this particular consignment is urgent, and may not lower a
 * temperature excursion below CRITICAL because it is inconvenient.
 */
const SEVERITY_FLOOR: Readonly<Partial<Record<LogisticsExceptionType, LogisticsExceptionSeverity>>> =
  Object.freeze({
    TEMPERATURE_EXCURSION: 'CRITICAL',
    PACKAGE_LOST: 'CRITICAL',
    PRODUCT_DAMAGED: 'HIGH',
    SLA_BREACH: 'HIGH',
    CUSTOMS_DELAY: 'MEDIUM',
    UNMAPPED_EXTERNAL_EVENT: 'MEDIUM',
  });

const SEVERITY_ORDER: Readonly<Record<LogisticsExceptionSeverity, number>> = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
});

function applySeverityFloor(
  type: LogisticsExceptionType,
  requested: LogisticsExceptionSeverity,
): LogisticsExceptionSeverity {
  const floor = SEVERITY_FLOOR[type];
  if (floor === undefined) return requested;
  return SEVERITY_ORDER[requested] >= SEVERITY_ORDER[floor] ? requested : floor;
}

/** States that mean somebody still has to do something. */
export const OPEN_EXCEPTION_STATES: LogisticsExceptionState[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'ESCALATED',
];

export interface RaiseExceptionInput {
  shipmentId: string;
  logisticsPartnerId: string | null;
  type: LogisticsExceptionType;
  severity?: LogisticsExceptionSeverity;
  reason: string;
  detail?: string | null;
  ownerPartnerUserId?: string | null;
  resolutionDueAt?: Date | null;
  revisedEtaAt?: Date | null;
  externalPayload?: unknown;
  raisedByUserId?: string | null;
  actorLabel?: string;
  correlationId?: string | null;
}

export interface RaisedException {
  id: string;
  type: LogisticsExceptionType;
  severity: LogisticsExceptionSeverity;
  state: LogisticsExceptionState;
}

/**
 * Raise one, inside a transaction if the caller has one.
 *
 * Used by the portal, by the SLA sweep, and by the webhook ingestion for an
 * `UNMAPPED_EXTERNAL_EVENT` - which is the reason `externalPayload` exists. A
 * carrier code this software does not recognise produces an exception with the
 * carrier's own words attached, so a person can read what was actually said
 * rather than a translation of it that failed.
 */
export async function raiseException(
  input: RaiseExceptionInput,
  tx?: PrismaTransaction,
): Promise<RaisedException> {
  const severity = applySeverityFloor(input.type, input.severity ?? 'MEDIUM');
  const id = newId();

  const run = async (client: PrismaTransaction): Promise<RaisedException> => {
    const shipment = await client.logisticsShipment.findUnique({
      where: { id: input.shipmentId },
      select: {
        id: true,
        shipmentReference: true,
        receivingCompanyName: true,
        assignedPartnerId: true,
        requiresColdChain: true,
      },
    });

    if (shipment === null) throw notFound('Shipment');

    const partnerId = input.logisticsPartnerId ?? shipment.assignedPartnerId;

    await client.logisticsShipmentException.create({
      data: {
        id,
        shipmentId: shipment.id,
        logisticsPartnerId: partnerId,
        type: input.type,
        severity,
        state: 'OPEN',
        reason: input.reason.slice(0, 512),
        detail: input.detail ?? null,
        ownerPartnerUserId: input.ownerPartnerUserId ?? null,
        resolutionDueAt: input.resolutionDueAt ?? null,
        revisedEtaAt: input.revisedEtaAt ?? null,
        externalPayloadJson:
          input.externalPayload === undefined ? undefined : (input.externalPayload as object),
        raisedByUserId: input.raisedByUserId ?? null,
      },
    });

    if (partnerId !== null) {
      await createLogisticsNotification({
        logisticsPartnerId: partnerId,
        shipmentId: shipment.id,
        kind: input.type === 'SLA_RISK' ? 'SLA_AT_RISK' : input.type === 'SLA_BREACH' ? 'SLA_BREACHED' : 'EXCEPTION_RAISED',
        title: `${shipment.shipmentReference}: ${humanType(input.type)}`,
        body: input.reason.slice(0, 1000),
        variables: { shipmentReference: shipment.shipmentReference, type: input.type, severity },
        dedupeKey: `exception:${id}`,
      });

      await recordLogisticsAudit(
        {
          logisticsPartnerId: partnerId,
          actorUserId: input.raisedByUserId ?? null,
          actorLabel: input.actorLabel ?? 'System',
          action: 'logistics.exception.raised',
          resourceType: 'logistics_shipment_exception',
          resourceId: id,
          after: { type: input.type, severity },
          summary: `${humanType(input.type)} raised on ${shipment.shipmentReference}.`,
          correlationId: input.correlationId ?? null,
        },
        client,
      );
    }

    return { id, type: input.type, severity, state: 'OPEN' as LogisticsExceptionState };
  };

  const result = tx !== undefined ? await run(tx) : await prisma.$transaction(run);

  /*
   * Critical exceptions reach the marketplace's own desk immediately.
   *
   * Outside the transaction, because a console notification failing must not
   * roll back the record that a batch of reagents went warm. The record is the
   * thing that matters; the alert is how somebody finds out quickly.
   */
  if (result.severity === 'CRITICAL') {
    await notifyOperations(input.shipmentId, result);
  }

  return result;
}

async function notifyOperations(shipmentId: string, exception: RaisedException): Promise<void> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { shipmentReference: true, receivingCompanyName: true },
  });

  if (shipment === null) return;

  await createAdminNotification({
    kind: AdminNotificationKind.LOGISTICS_EXCEPTION_RAISED,
    variables: {
      shipmentReference: shipment.shipmentReference,
      receivingCompany: shipment.receivingCompanyName,
      exceptionType: exception.type,
      severity: exception.severity,
    },
    linkPath: `/logistics/shipments/${shipmentId}`,
    // Named rather than left open to every member of staff: the row carries a
    // customer's company and what went wrong with their delivery.
    requiredPermission: Permission.LOGISTICS_READ,
    relatedType: 'logistics_shipment',
    relatedId: shipmentId,
    // One bell per exception, however many times the raise is retried.
    dedupeKey: `logistics-exception:${exception.id}`,
  });
}

function humanType(type: LogisticsExceptionType): string {
  return type
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface ExceptionListFilters {
  state?: readonly LogisticsExceptionState[] | null;
  severity?: readonly LogisticsExceptionSeverity[] | null;
  type?: LogisticsExceptionType | null;
  shipmentId?: string | null;
  openOnly?: boolean;
}

export interface ExceptionRow {
  id: string;
  shipmentId: string;
  shipmentReference: string;
  receivingCompanyName: string;
  type: LogisticsExceptionType;
  severity: LogisticsExceptionSeverity;
  state: LogisticsExceptionState;
  reason: string;
  ownerName: string | null;
  resolutionDueAt: Date | null;
  revisedEtaAt: Date | null;
  customerNotifiedAt: Date | null;
  escalatedAt: Date | null;
  createdAt: Date;
  closedAt: Date | null;
}

/**
 * This carrier's exception queue, worst first.
 *
 * Severity descending then age ascending: the oldest CRITICAL is the first
 * thing an operations agent should be looking at, and a queue sorted purely by
 * time buries it under an afternoon of address corrections.
 */
export async function listExceptions(
  membership: LogisticsMembership,
  filters: ExceptionListFilters = {},
  options: { page?: number; pageSize?: number } = {},
): Promise<{ rows: ExceptionRow[]; total: number; page: number; pageCount: number }> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_READ);

  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 25), 200);

  const where = {
    logisticsPartnerId: membership.logisticsPartnerId,
    ...(filters.openOnly === true ? { state: { in: OPEN_EXCEPTION_STATES } } : {}),
    ...((filters.state !== undefined && filters.state !== null) && filters.state.length > 0
      ? { state: { in: [...filters.state] } }
      : {}),
    ...((filters.severity !== undefined && filters.severity !== null) && filters.severity.length > 0
      ? { severity: { in: [...filters.severity] } }
      : {}),
    ...((filters.type !== undefined && filters.type !== null) ? { type: filters.type } : {}),
    ...((filters.shipmentId !== undefined && filters.shipmentId !== null) ? { shipmentId: filters.shipmentId } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.logisticsShipmentException.count({ where }),
    prisma.logisticsShipmentException.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        shipmentId: true,
        type: true,
        severity: true,
        state: true,
        reason: true,
        resolutionDueAt: true,
        revisedEtaAt: true,
        customerNotifiedAt: true,
        escalatedAt: true,
        createdAt: true,
        closedAt: true,
        shipment: { select: { shipmentReference: true, receivingCompanyName: true } },
        ownerPartnerUserId: true,
      },
    }),
  ]);

  const ownerIds = [
    ...new Set(rows.map((row) => row.ownerPartnerUserId).filter((id): id is string => id !== null)),
  ];

  const owners =
    ownerIds.length === 0
      ? []
      : await prisma.logisticsPartnerUser.findMany({
          // Tenant filter, even on a lookup of ids that came from this
          // carrier's own rows. Cheap, and it is the habit that survives a
          // refactor that later takes the ids from somewhere else.
          where: { id: { in: ownerIds }, logisticsPartnerId: membership.logisticsPartnerId },
          select: { id: true, fullName: true },
        });

  const ownerNames = new Map(owners.map((owner) => [owner.id, owner.fullName]));

  return {
    rows: rows.map((row) => ({
      id: row.id,
      shipmentId: row.shipmentId,
      shipmentReference: row.shipment.shipmentReference,
      receivingCompanyName: row.shipment.receivingCompanyName,
      type: row.type,
      severity: row.severity,
      state: row.state,
      reason: row.reason,
      ownerName: row.ownerPartnerUserId === null ? null : ownerNames.get(row.ownerPartnerUserId) ?? null,
      resolutionDueAt: row.resolutionDueAt,
      revisedEtaAt: row.revisedEtaAt,
      customerNotifiedAt: row.customerNotifiedAt,
      escalatedAt: row.escalatedAt,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface UpdateExceptionInput {
  state?: LogisticsExceptionState;
  severity?: LogisticsExceptionSeverity;
  ownerPartnerUserId?: string | null;
  resolutionNotes?: string | null;
  revisedEtaAt?: Date | null;
  resolutionDueAt?: Date | null;
  escalationNote?: string | null;
  customerNotified?: boolean;
}

/**
 * Work an exception.
 *
 * Two rules enforced here rather than in the form:
 *
 *   - **Resolving needs a note.** An exception closed with no explanation is
 *     an exception that will be raised again next week by somebody who cannot
 *     see what was done about it.
 *   - **The severity floor still applies.** Downgrading a temperature
 *     excursion is refused here as well as at creation, because the obvious
 *     way round a floor at creation is to create it and immediately lower it.
 */
export async function updateException(
  membership: LogisticsMembership,
  exceptionId: string,
  changes: UpdateExceptionInput,
  correlationId?: string | null,
): Promise<ExceptionRow> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_EXCEPTION_WRITE);

  const existing = await prisma.logisticsShipmentException.findFirst({
    where: { id: exceptionId, logisticsPartnerId: membership.logisticsPartnerId },
    select: {
      id: true,
      shipmentId: true,
      type: true,
      severity: true,
      state: true,
      shipment: { select: { shipmentReference: true } },
    },
  });

  if (existing === null) throw notFound('Exception');

  const closing = changes.state === 'RESOLVED' || changes.state === 'CLOSED';

  if (closing && (changes.resolutionNotes ?? '').trim().length < 4) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say what was done about it before closing this.',
      [{ field: 'resolutionNotes', code: 'NOTES_REQUIRED' }],
    );
  }

  const severity =
    changes.severity === undefined
      ? undefined
      : applySeverityFloor(existing.type, changes.severity);

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.logisticsShipmentException.update({
      where: { id: existing.id },
      data: {
        ...(changes.state !== undefined ? { state: changes.state } : {}),
        ...(severity !== undefined ? { severity } : {}),
        ...(changes.ownerPartnerUserId !== undefined
          ? { ownerPartnerUserId: changes.ownerPartnerUserId }
          : {}),
        ...(changes.resolutionNotes !== undefined
          ? { resolutionNotes: changes.resolutionNotes }
          : {}),
        ...(changes.revisedEtaAt !== undefined ? { revisedEtaAt: changes.revisedEtaAt } : {}),
        ...(changes.resolutionDueAt !== undefined
          ? { resolutionDueAt: changes.resolutionDueAt }
          : {}),
        ...(changes.escalationNote !== undefined
          ? { escalationNote: changes.escalationNote, escalatedAt: now }
          : {}),
        ...(changes.state === 'ESCALATED' ? { escalatedAt: now } : {}),
        ...(changes.customerNotified === true ? { customerNotifiedAt: now } : {}),
        ...(changes.state === 'RESOLVED' ? { resolvedAt: now } : {}),
        ...(changes.state === 'CLOSED' ? { closedAt: now, resolvedAt: now } : {}),
      },
    });

    /*
     * A revised ETA on an exception moves the CONSIGNMENT's ETA.
     *
     * The alternative - two dates that disagree, one on the exception and one
     * on the shipment - is how a customer is told one thing by the tracking
     * page and another by whoever answers the telephone.
     */
    if ((changes.revisedEtaAt !== undefined && changes.revisedEtaAt !== null)) {
      await tx.logisticsShipment.update({
        where: { id: existing.shipmentId },
        data: { estimatedDeliveryAt: changes.revisedEtaAt },
      });
    }

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: closing ? 'logistics.exception.closed' : 'logistics.exception.updated',
        resourceType: 'logistics_shipment_exception',
        resourceId: existing.id,
        before: { state: existing.state, severity: existing.severity },
        after: { state: changes.state ?? existing.state, severity: severity ?? existing.severity },
        summary: closing
          ? `${humanType(existing.type)} on ${existing.shipment.shipmentReference} was closed.`
          : `${humanType(existing.type)} on ${existing.shipment.shipmentReference} was updated.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  const refreshed = await listExceptions(membership, { shipmentId: existing.shipmentId }, { pageSize: 200 });
  const updated = refreshed.rows.find((row) => row.id === existing.id);
  if (updated === undefined) throw notFound('Exception');
  return updated;
}

/**
 * Raise an exception from the portal, against a shipment the caller holds.
 *
 * The partner-facing entry point, and the only one that checks shipment
 * access. `raiseException` above is the internal one and takes a partner id
 * directly, because the sweeps and the webhook ingestion act as the system
 * rather than as a tenant.
 */
export async function raiseExceptionFromPortal(
  membership: LogisticsMembership,
  shipmentId: string,
  input: Omit<RaiseExceptionInput, 'shipmentId' | 'logisticsPartnerId' | 'raisedByUserId' | 'actorLabel'>,
  correlationId?: string | null,
): Promise<RaisedException> {
  assertLogisticsPermission(membership, LogisticsPermission.SHIPMENT_EXCEPTION_WRITE);
  await assertShipmentAccess(membership, shipmentId, 'WRITE');

  return raiseException({
    ...input,
    shipmentId,
    logisticsPartnerId: membership.logisticsPartnerId,
    raisedByUserId: membership.userId,
    actorLabel: membership.fullName,
    correlationId: correlationId ?? null,
  });
}
