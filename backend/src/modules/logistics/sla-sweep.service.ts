/**
 * Keeping the stored SLA column honest.
 *
 * `LogisticsShipment.slaState` is a PROJECTION, not a source of truth. The
 * list and the detail page recompute live from `assessSla`, and the column
 * exists for one reason: so the dashboard can COUNT "how many are at risk"
 * without evaluating a time window over every open consignment on every page
 * load. On a table of millions that is the difference between a dashboard and
 * a timeout.
 *
 * Because it is a projection, it can be stale, and staleness here is cheap: a
 * consignment that crossed its deadline four minutes ago shows as at-risk on
 * the dashboard and as breached on the list, and the list is right. The sweep
 * closes the gap on the maintenance beat.
 *
 * IT ALSO RAISES THE TWO SLA EXCEPTIONS
 *
 * `SLA_RISK` when a consignment enters the risk window and `SLA_BREACH` when
 * it crosses the deadline - each exactly once per consignment, which the
 * exception table's own rows make easy to check. Without this the portal would
 * have an "SLA at risk" counter and nothing in the exception queue to work,
 * and a number nobody can act on is a number people stop reading.
 */
import { assessSla } from '../../domain/logistics-sla.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { raiseException } from './exception.service.js';

/** How many consignments one pass looks at. */
const BATCH = 500;

/**
 * Recompute `slaState` for every consignment still in motion.
 *
 * Closed ones are skipped: a delivered, cancelled, lost or returned
 * consignment's SLA cannot change again, and re-evaluating them every ten
 * minutes for the life of the installation is the classic sweep that gets
 * slower for ever.
 */
export async function refreshSlaStates(now = new Date()): Promise<{
  updated: number;
  exceptionsRaised: number;
}> {
  const open = await prisma.logisticsShipment.findMany({
    where: {
      status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
      // Nothing to assess without at least one promise.
      OR: [{ pickupDueAt: { not: null } }, { deliveryDueAt: { not: null } }],
    },
    // Oldest evaluation first, so a backlog drains in order rather than the
    // same five hundred rows being re-examined every pass.
    orderBy: [{ slaEvaluatedAt: { sort: 'asc', nulls: 'first' } }],
    take: BATCH,
    select: {
      id: true,
      status: true,
      slaState: true,
      pickupDueAt: true,
      deliveryDueAt: true,
      pickedUpAt: true,
      deliveredAt: true,
      closedAt: true,
      assignedPartnerId: true,
      shipmentReference: true,
      slaPolicy: { select: { riskWindowMinutes: true } },
    },
  });

  let updated = 0;
  let exceptionsRaised = 0;

  for (const shipment of open) {
    const assessment = assessSla({
      pickupDueAt: shipment.pickupDueAt,
      deliveryDueAt: shipment.deliveryDueAt,
      pickedUpAt: shipment.pickedUpAt,
      deliveredAt: shipment.deliveredAt,
      isClosed: shipment.closedAt !== null,
      riskWindowMinutes: shipment.slaPolicy?.riskWindowMinutes ?? 120,
      now,
    });

    /*
     * `slaEvaluatedAt` is written even when the state has not moved.
     *
     * That is what makes the `nulls: 'first'` ordering above a rotation rather
     * than a loop: without it the same batch of never-changing consignments
     * would be at the front of the queue for ever and the ones behind them
     * would never be looked at.
     */
    await prisma.logisticsShipment.update({
      where: { id: shipment.id },
      data: { slaState: assessment.state, slaEvaluatedAt: now },
    });

    if (assessment.state === shipment.slaState) continue;

    updated += 1;

    if (assessment.state !== 'AT_RISK' && assessment.state !== 'BREACHED') continue;

    const type = assessment.state === 'AT_RISK' ? 'SLA_RISK' : 'SLA_BREACH';

    /*
     * Once per consignment per kind.
     *
     * A sweep that raised a fresh exception every ten minutes for a late
     * parcel would bury the queue it is meant to fill. The check is a query
     * rather than a constraint because the natural key - shipment plus type -
     * would also refuse a genuinely new breach after an earlier one was
     * resolved, which is a case the operations desk does want to see.
     */
    const existing = await prisma.logisticsShipmentException.findFirst({
      where: {
        shipmentId: shipment.id,
        type,
        state: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED'] },
      },
      select: { id: true },
    });

    if (existing !== null) continue;

    try {
      await raiseException({
        shipmentId: shipment.id,
        logisticsPartnerId: shipment.assignedPartnerId,
        type,
        severity: assessment.state === 'BREACHED' ? 'HIGH' : 'MEDIUM',
        reason:
          assessment.state === 'BREACHED'
            ? `${shipment.shipmentReference} has missed its agreed time by ${String(
                assessment.minutesLate,
              )} minutes.`
            : `${shipment.shipmentReference} is due in ${String(
                assessment.minutesRemaining ?? 0,
              )} minutes and has not moved.`,
        resolutionDueAt: shipment.deliveryDueAt,
      });

      exceptionsRaised += 1;
    } catch (error) {
      // One consignment must not stop the sweep. The state is already
      // written; the exception is retried next pass.
      logger.warn({ err: error, shipmentId: shipment.id }, 'could not raise an SLA exception');
    }
  }

  return { updated, exceptionsRaised };
}
