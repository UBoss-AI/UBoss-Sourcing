/**
 * Where a seller's consignment stands, in the words each audience reads.
 *
 * Pure. No Prisma, no clock. It takes the facts that are already stored and
 * returns a stage - it never stores one. That is deliberate: the order, the
 * payment, the consignment, the carrier's offer, the driver and a hand-made
 * booking each have their own status column with its own state machine, and
 * the temptation this file resists is a sixth column that tries to mean all of
 * them. A combined status that is written is a status that disagrees with its
 * parts within a week. A combined status that is DERIVED cannot.
 *
 * ONE FUNCTION, FOUR SCREENS. The seller's order page, the logistics portal,
 * the admin panel and the buyer's order page all call this, so "picked up" on
 * one of them is "picked up" on all of them. The buyer then gets a coarser
 * version through `customerDeliveryStage`, which folds away everything that is
 * the seller's and the carrier's business - a refusal, a pending offer, which
 * driver.
 */
import type { ShipmentStatusName } from './logistics-shipment-state.js';

/**
 * The seller's side of the order, separate from anything logistics.
 *
 * Kept apart from `LogisticsStage` because it answers a different question -
 * has the SELLER agreed to supply this - and a consignment can exist before
 * they have (it is raised when the order is paid).
 */
export type SellerOrderStage =
  | 'SELLER_CONFIRMATION_REQUIRED'
  | 'SELLER_CONFIRMED'
  | 'SELLER_REJECTED'
  | 'CANCELLED'
  | 'COMPLETED';

/** Seller-order statuses in which the seller has agreed to supply. */
const CONFIRMED_SELLER_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'ACCEPTED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
  'SHIPPED',
  'DELIVERED',
]);

/**
 * Whether the seller has confirmed their part of the order.
 *
 * The gate on handing a consignment to anybody. A carrier offered work for an
 * order the seller may still refuse has been given an obligation nobody
 * agreed to.
 */
export function sellerHasConfirmed(sellerOrderStatus: string): boolean {
  return CONFIRMED_SELLER_ORDER_STATUSES.has(sellerOrderStatus);
}

export function sellerOrderStage(sellerOrderStatus: string): SellerOrderStage {
  switch (sellerOrderStatus) {
    case 'NEW':
      return 'SELLER_CONFIRMATION_REQUIRED';
    case 'CANCELLED':
      // A seller order is only ever cancelled before it ships, and before it
      // ships only the seller or the marketplace can cancel it. Both read the
      // same to the people downstream: this part is not coming.
      return 'SELLER_REJECTED';
    case 'DELIVERED':
    case 'RETURNED':
      return 'COMPLETED';
    default:
      return CONFIRMED_SELLER_ORDER_STATUSES.has(sellerOrderStatus)
        ? 'SELLER_CONFIRMED'
        : 'CANCELLED';
  }
}

/**
 * Where the consignment itself stands.
 *
 * The names are the business workflow's, and each maps from facts:
 *
 *   AWAITING_LOGISTICS_ASSIGNMENT  nobody named yet
 *   PARTNER_REJECTED               nobody named, because the last one said no
 *   ASSIGNMENT_PENDING             offered to a delivery company, unanswered
 *   CARRIER_BOOKING_PENDING        DHL/FedEx/India Post chosen by hand, and the
 *                                  carrier's own number not yet typed in
 *   DRIVER_ASSIGNMENT_REQUIRED     accepted, no driver yet
 *   DRIVER_ASSIGNED                accepted, a driver on it
 *   PICKUP_SCHEDULED .. RETURNED   the parcel's own journey
 *
 * `PARTNER_ACCEPTED` from the brief is the instant between an acceptance and
 * the next fact about a driver. For a delivery company on this platform the
 * next fact is always "driver or no driver", so it is reported as one of
 * those two - a stage that is only ever true for a millisecond is a stage no
 * screen should wait on.
 */
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

export interface LogisticsStageFacts {
  shipmentStatus: ShipmentStatusName;
  /**
   * The newest assignment row for the consignment, whatever its state, or
   * null if it was never offered to anybody.
   */
  latestAssignmentState:
    | 'OFFERED'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'WITHDRAWN'
    | 'EXPIRED'
    | 'COMPLETED'
    | null;
  /** A live driver assignment exists. */
  hasActiveDriver: boolean;
  /** The live hand-made booking, if there is one. */
  manualBookingStatus: 'BOOKING_REQUIRED' | 'BOOKED' | null;
}

export function logisticsStage(facts: LogisticsStageFacts): LogisticsStage {
  switch (facts.shipmentStatus) {
    case 'CANCELLED':
      return 'CANCELLED';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'RETURNED':
      return 'RETURNED';
    case 'RETURN_REQUESTED':
    case 'RETURN_IN_TRANSIT':
      return 'RETURNING';
    case 'DELIVERY_FAILED':
    case 'LOST':
      return 'DELIVERY_FAILED';
    case 'OUT_FOR_DELIVERY':
    case 'DELIVERY_ATTEMPTED':
      // An attempt is not a failure. The carrier will try again, and a buyer
      // told "failed" after one missed doorbell calls the seller.
      return 'OUT_FOR_DELIVERY';
    case 'DISPATCHED':
    case 'AT_ORIGIN_HUB':
    case 'IN_TRANSIT':
    case 'AT_DESTINATION_HUB':
    case 'DELAYED':
    case 'CUSTOMS_HOLD':
    case 'ADDRESS_ISSUE':
    case 'DAMAGED':
    case 'TEMPERATURE_EXCEPTION':
      return 'IN_TRANSIT';
    case 'PICKED_UP':
      return 'PICKED_UP';
    case 'PICKUP_SCHEDULED':
    case 'READY_FOR_PICKUP':
      return 'PICKUP_SCHEDULED';
    case 'ON_HOLD':
      // Held before or after collection. Before, it has not moved; after, it is
      // on its way and paused. Which one is told by whether it was collected,
      // and without that fact the earlier stage is the honest answer.
      return facts.latestAssignmentState === 'ACCEPTED'
        ? facts.hasActiveDriver
          ? 'DRIVER_ASSIGNED'
          : 'DRIVER_ASSIGNMENT_REQUIRED'
        : 'AWAITING_LOGISTICS_ASSIGNMENT';
    case 'ACCEPTED':
      return facts.hasActiveDriver ? 'DRIVER_ASSIGNED' : 'DRIVER_ASSIGNMENT_REQUIRED';
    case 'ASSIGNED':
    case 'ACCEPTANCE_PENDING':
      return facts.manualBookingStatus !== null ? 'CARRIER_BOOKING_PENDING' : 'ASSIGNMENT_PENDING';
    case 'CREATED':
    case 'AWAITING_ASSIGNMENT':
      return facts.latestAssignmentState === 'REJECTED' ||
        facts.latestAssignmentState === 'EXPIRED'
        ? 'PARTNER_REJECTED'
        : 'AWAITING_LOGISTICS_ASSIGNMENT';
  }
}

/**
 * The stages at which a seller may still hand the consignment to somebody
 * else without anybody's permission.
 *
 * Everything before the carrier has the goods. After collection, the parcel
 * is in a van, and moving it to another company is a chain-of-custody event
 * that only the carrier holding it and the marketplace can arrange.
 */
const SELLER_REASSIGNABLE_STATUSES: ReadonlySet<ShipmentStatusName> = new Set<ShipmentStatusName>([
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
]);

export function sellerMayReassign(status: ShipmentStatusName): boolean {
  return SELLER_REASSIGNABLE_STATUSES.has(status);
}

/**
 * What the BUYER is told.
 *
 * Coarser on purpose, and never more hopeful than the facts. A carrier's
 * refusal is the seller's problem to solve and the buyer hears "awaiting a
 * carrier" until it is solved; which driver, which offer and which company
 * turned it down are not the buyer's business.
 */
export type CustomerDeliveryStage =
  | 'SELLER_CONFIRMATION_REQUIRED'
  | 'SELLER_CONFIRMED'
  | 'AWAITING_LOGISTICS_ASSIGNMENT'
  | 'LOGISTICS_PARTNER_ASSIGNED'
  | 'PICKUP_SCHEDULED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'RETURNING'
  | 'RETURNED'
  | 'CANCELLED';

export function customerDeliveryStage(input: {
  /** The seller's part of the order, or null for the shop's own stock. */
  sellerOrderStatus: string | null;
  /** Null where no consignment has been raised yet. */
  stage: LogisticsStage | null;
}): CustomerDeliveryStage {
  if (input.sellerOrderStatus !== null) {
    const seller = sellerOrderStage(input.sellerOrderStatus);
    if (seller === 'SELLER_CONFIRMATION_REQUIRED') return 'SELLER_CONFIRMATION_REQUIRED';
    if (seller === 'SELLER_REJECTED' || seller === 'CANCELLED') return 'CANCELLED';
  }

  // Confirmed, and the consignment not raised yet. True and complete.
  if (input.stage === null) return 'SELLER_CONFIRMED';

  switch (input.stage) {
    case 'AWAITING_LOGISTICS_ASSIGNMENT':
    case 'PARTNER_REJECTED':
    case 'ASSIGNMENT_PENDING':
      // An offer nobody has accepted is not a carrier the buyer can count on.
      return 'AWAITING_LOGISTICS_ASSIGNMENT';
    case 'CARRIER_BOOKING_PENDING':
    case 'DRIVER_ASSIGNMENT_REQUIRED':
    case 'DRIVER_ASSIGNED':
      return 'LOGISTICS_PARTNER_ASSIGNED';
    default:
      return input.stage;
  }
}
