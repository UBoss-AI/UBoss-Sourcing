/**
 * The driver-assignment record: closing one, and reading the chain.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * A leaf. It imports the database and nothing else in this module, and that is
 * the whole point: `shipment-event.service.ts` has to close a driver's stop
 * when a consignment finishes, and `driver.service.ts` - where assigning lives
 * - reaches `shipment-event` through `operations.service.ts`. Putting these two
 * functions beside `assignDriver` would have made that a cycle
 * (shipment-event → driver → operations → shipment-event). ESM tolerates one;
 * the next person to move an import does not have to.
 *
 * THE INVARIANT BOTH FUNCTIONS EXIST TO HOLD
 *
 * `unassignedAt` and `activeShipmentId` are written **together, always**: set
 * one and clear the other, or the unique index that guarantees one live driver
 * per consignment starts refusing assignments for parcels nobody is carrying.
 * Every write of either column in this codebase is in this file or in
 * `assignDriver`, and that is a rule worth keeping true.
 */
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/**
 * The consignment is finished; the driver's stop is finished with it.
 *
 * Called from `recordShipmentEvent`, inside its transaction, when a shipment
 * reaches a tracking-complete status. Without it a delivered parcel stays on
 * its driver's open-task count for ever, and the number on the fleet screen
 * only ever goes up - which is how a dispatcher stops reading it.
 *
 * `activeShipmentId` is cleared as well as `completedAt` being set, so a
 * consignment later corrected out of a terminal status can be given to a
 * driver again rather than being refused by the unique index for a stop that
 * ended weeks ago.
 */
export async function completeDriverAssignmentsFor(
  shipmentId: string,
  tx?: PrismaTransaction,
): Promise<number> {
  const client = tx ?? prisma;
  const now = new Date();

  const result = await client.logisticsDriverAssignment.updateMany({
    where: { shipmentId, unassignedAt: null },
    data: { unassignedAt: now, completedAt: now, activeShipmentId: null },
  });

  return result.count;
}

/** One link in the chain of people who have held a consignment. */
export interface DriverAssignmentHistoryEntry {
  id: string;
  driverProfileId: string;
  driverName: string;
  vehicleRegistration: string | null;
  isPickupLeg: boolean;
  isDeliveryLeg: boolean;
  assignedAt: string;
  unassignedAt: string | null;
  completedAt: string | null;
  /** Why they came off, where a dispatcher gave a reason. */
  unassignedReason: string | null;
  /** The assignment this one replaced. Null for the first. */
  previousAssignmentId: string | null;
  /** Who put them on it. Null where the record predates the column. */
  assignedByName: string | null;
  /** Whether this is the one that counts right now. */
  isActive: boolean;
}

/**
 * Everyone who has carried this consignment, oldest first.
 *
 * Oldest first, unlike every other list in this codebase, and deliberately:
 * this is a chain rather than a feed. "A, then B because A was sick, then C
 * because B's van broke" reads forwards; reversed it is a puzzle.
 *
 * **Takes a shipment id the caller has already authorised.** It is read by the
 * carrier's own screen through `assertShipmentAccess` and by the marketplace's
 * through `logistics.read`, so the tenant check belongs to the caller rather
 * than being duplicated - and duplicated differently - here.
 */
export async function readDriverAssignmentHistory(
  shipmentId: string,
): Promise<DriverAssignmentHistoryEntry[]> {
  const rows = await prisma.logisticsDriverAssignment.findMany({
    where: { shipmentId },
    orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    take: 50,
    select: {
      id: true,
      driverProfileId: true,
      isPickupLeg: true,
      isDeliveryLeg: true,
      assignedAt: true,
      unassignedAt: true,
      completedAt: true,
      unassignedReason: true,
      previousAssignmentId: true,
      assignedByPartnerUserId: true,
      assignedByLabel: true,
      driver: { select: { fullName: true } },
      vehicle: { select: { registration: true } },
    },
  });

  /*
   * The member ids, for rows written before `assignedByLabel` existed.
   *
   * The label is the answer for everything written since - and the only
   * possible answer for an assignment the marketplace made, because an
   * operator has no row in the carrier's own team. This lookup is the
   * back-compatibility path, and it costs one query rather than a join per row:
   * a consignment that has changed hands four times would otherwise be four
   * extra round trips on a screen that lists many.
   */
  const assignerIds = [
    ...new Set(
      rows
        .filter((row) => row.assignedByLabel === null)
        .map((row) => row.assignedByPartnerUserId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const assigners =
    assignerIds.length === 0
      ? []
      : await prisma.logisticsPartnerUser.findMany({
          where: { id: { in: assignerIds } },
          select: { id: true, fullName: true },
        });

  const assignerNames = new Map(assigners.map((row) => [row.id, row.fullName]));

  return rows.map((row) => ({
    id: row.id,
    driverProfileId: row.driverProfileId,
    driverName: row.driver.fullName,
    vehicleRegistration: row.vehicle?.registration ?? null,
    isPickupLeg: row.isPickupLeg,
    isDeliveryLeg: row.isDeliveryLeg,
    assignedAt: row.assignedAt.toISOString(),
    unassignedAt: row.unassignedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    unassignedReason: row.unassignedReason,
    previousAssignmentId: row.previousAssignmentId,
    // The label first: it is the only answer for an assignment the
    // marketplace made, and the stored one for everything written since the
    // column existed. The member lookup is the fallback for older rows.
    assignedByName:
      row.assignedByLabel ??
      (row.assignedByPartnerUserId === null
        ? null
        : (assignerNames.get(row.assignedByPartnerUserId) ?? null)),
    isActive: row.unassignedAt === null,
  }));
}
