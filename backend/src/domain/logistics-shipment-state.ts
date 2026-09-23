/**
 * Logistics shipment state machine.
 *
 * Every status change goes through `assertShipmentTransition`. Services never
 * write `status` directly. Same rule as `order-state-machine.ts` and
 * `schedule-state.ts`, and it matters more here than in either of them: a
 * shipment changes status inside a webhook handler with nobody watching, and
 * the state it lands in decides whether a hospital is told its consignment
 * arrived.
 *
 * TWO THINGS THIS FILE IS THE ONLY SOURCE OF
 *
 *   1. **The canonical status list.** Carriers each have their own vocabulary
 *      - DHL says "Shipment picked up", FedEx says "PU", UPS says "O" - and
 *      `carrier-status-map.ts` translates every one of them into a member of
 *      `ShipmentStatusValues` below. A provider code nothing maps to is
 *      preserved verbatim and flagged; it never becomes a status.
 *   2. **What may follow what.** The portal renders exactly the buttons
 *      `allowedShipmentTransitions` returns, and the endpoint behind each
 *      button asks the same function again. A UI restriction is not a security
 *      control.
 *
 * THE THREE RULES FROM THE BRIEF THAT SHAPE THE MATRIX
 *
 *   - An ASSIGNED shipment cannot be marked DELIVERED. Nothing reaches
 *     DELIVERED except from OUT_FOR_DELIVERY or DELIVERY_ATTEMPTED, because a
 *     parcel that was never out for delivery was not delivered.
 *   - A partner cannot reverse DELIVERED. The only edge out of it is
 *     RETURN_REQUESTED, and only the marketplace or the system may take it.
 *     Anything else needs `assertShipmentCorrection` below, which is an
 *     operator act carrying a mandatory reason.
 *   - A CANCELLED shipment accepts no further tracking, with one exception:
 *     goods already collected have to come back, so CANCELLED ->
 *     RETURN_REQUESTED stays open.
 */
import { ErrorCode, conflict } from './errors.js';
import { LogisticsPermission, type LogisticsPermissionKey } from './logistics-permissions.js';

/**
 * Every status a shipment can hold.
 *
 * The first fifteen are the forward path, in the order a parcel walks them.
 * The rest are exceptions and terminals. The order of this array is the order
 * the portal renders a status filter in, so it is the reading order rather
 * than alphabetical.
 */
export const ShipmentStatusValues = [
  // --- The forward path ---
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',

  // --- Exceptions: recoverable, and the parcel rejoins the path ---
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',

  // --- Returns ---
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',

  // --- Terminal ---
  'LOST',
  'CANCELLED',
] as const;

export type ShipmentStatusName = (typeof ShipmentStatusValues)[number];

/**
 * Who is allowed to request a transition.
 *
 * `PARTNER` is a human in the portal, `DRIVER` the same person on a phone,
 * `CARRIER` an inbound webhook or a polled tracking record, `UBOSS_ADMIN` a
 * member of the marketplace's own staff, and `SYSTEM` this software acting on
 * its own - an order being cancelled, an assignment lapsing, a sweep closing
 * out an abandoned pickup.
 *
 * DRIVER is separate from PARTNER rather than a narrower version of it,
 * because the two can do genuinely different things: a driver may mark a
 * delivery attempted from the doorstep and may not cancel a shipment from it.
 *
 * SELLER is the seller recording, by hand, what their OWN outside carrier -
 * DHL, FedEx, India Post booked without an API account - told them. It has a
 * short list of edges of its own, below, and nothing else: it cannot touch a
 * consignment a delivery company on this platform is carrying, and the
 * service refuses it on any consignment without a live hand-made booking.
 * The matrix is the second lock on that door, not the first.
 */
export type ShipmentActor = 'PARTNER' | 'DRIVER' | 'CARRIER' | 'UBOSS_ADMIN' | 'SYSTEM' | 'SELLER';

interface ShipmentTransitionRule {
  to: ShipmentStatusName;
  actors: readonly ShipmentActor[];
  /** Logistics permission a PARTNER or DRIVER actor must hold. */
  permission?: LogisticsPermissionKey;
  /** Free-text reason required from the actor. */
  requiresReason?: boolean;
  /**
   * A Proof of Delivery must exist, or be supplied with the same call, before
   * this transition is accepted.
   *
   * Only DELIVERED carries it, and what "a Proof of Delivery" means is the
   * deployment's own policy - see `LogisticsSlaPolicy.podPolicyJson`. This
   * flag says the policy is consulted; it does not say what the policy is.
   */
  requiresProofOfDelivery?: boolean;
}

const STATUS_WRITE = LogisticsPermission.SHIPMENT_STATUS_WRITE;
const ACCEPT = LogisticsPermission.SHIPMENT_ACCEPT;
const POD_WRITE = LogisticsPermission.POD_WRITE;
const PICKUP_WRITE = LogisticsPermission.PICKUP_WRITE;
const DISPATCH_WRITE = LogisticsPermission.DISPATCH_WRITE;

/** Every actor that is a person inside the carrier, for the common case. */
const CARRIER_STAFF: readonly ShipmentActor[] = Object.freeze(['PARTNER', 'UBOSS_ADMIN', 'SYSTEM']);
/** The same, plus a courier on a phone and a provider feed. */
const ANYONE_IN_THE_FIELD: readonly ShipmentActor[] = Object.freeze([
  'PARTNER',
  'DRIVER',
  'CARRIER',
  'UBOSS_ADMIN',
  'SYSTEM',
]);

/**
 * The exceptions a parcel in motion can fall into, and who may declare each.
 *
 * Factored out because eight statuses share them verbatim and eight copies of
 * the same six rules is eight places for them to drift apart.
 */
const IN_MOTION_EXCEPTIONS: readonly ShipmentTransitionRule[] = Object.freeze([
  // SELLER may report a delay their own outside carrier told them about. The
  // service allows it only on a consignment they booked by hand.
  {
    to: 'DELAYED',
    actors: [...ANYONE_IN_THE_FIELD, 'SELLER'],
    permission: STATUS_WRITE,
    requiresReason: true,
  },
  { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
  { to: 'DAMAGED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
  { to: 'LOST', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
  {
    to: 'TEMPERATURE_EXCEPTION',
    actors: ANYONE_IN_THE_FIELD,
    permission: STATUS_WRITE,
    requiresReason: true,
  },
]);

/**
 * Adjacency list of legal transitions.
 *
 * Deliberately absent, and the reasons why:
 *   - Anything -> DELIVERED except from OUT_FOR_DELIVERY or
 *     DELIVERY_ATTEMPTED. A parcel that was never out for delivery was not
 *     delivered, and this is the edge every "mark it done" bug tries to take.
 *   - DELIVERED -> anything but RETURN_REQUESTED. Settled is settled; the
 *     operator's correction path is `assertShipmentCorrection`.
 *   - RETURNED, LOST -> nothing. Terminal by design.
 *   - CANCELLED -> anything but RETURN_REQUESTED. A cancelled shipment stops
 *     accepting tracking, and goods already collected still have to come back.
 */
const SHIPMENT_TRANSITIONS: Readonly<
  Record<ShipmentStatusName, readonly ShipmentTransitionRule[]>
> = Object.freeze({
  /*
   * Created but not yet offered to anybody. The marketplace's own state: a
   * shipment is built from an order the moment it is ready to be fulfilled,
   * before anybody has decided who carries it.
   */
  CREATED: [
    { to: 'AWAITING_ASSIGNMENT', actors: ['UBOSS_ADMIN', 'SYSTEM'] },
    // The seller chose an outside carrier by hand. ASSIGNED means "somebody
    // has been named", which is true; nobody has been ASKED, because there is
    // nobody on this platform to ask.
    { to: 'ASSIGNED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  AWAITING_ASSIGNMENT: [
    { to: 'ASSIGNED', actors: ['UBOSS_ADMIN', 'SYSTEM', 'SELLER'] },
    { to: 'ON_HOLD', actors: ['UBOSS_ADMIN'], requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  /*
   * A partner has been named. The offer is made but not yet put to them -
   * ACCEPTANCE_PENDING is what the partner sees in their inbox.
   */
  ASSIGNED: [
    { to: 'ACCEPTANCE_PENDING', actors: ['UBOSS_ADMIN', 'SYSTEM'] },
    // Reassignment: the named partner never answered, or the operator changed
    // their mind. Back to the pool rather than forward. A seller cancelling a
    // hand-made booking takes the same edge, and owes the same reason.
    {
      to: 'AWAITING_ASSIGNMENT',
      actors: ['UBOSS_ADMIN', 'SYSTEM', 'SELLER'],
      requiresReason: true,
    },
    // Booked outside Glovia: the seller has the carrier's waybill or
    // collection reference. The service demands one before it takes this.
    { to: 'PICKUP_SCHEDULED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  ACCEPTANCE_PENDING: [
    { to: 'ACCEPTED', actors: ['PARTNER', 'UBOSS_ADMIN'], permission: ACCEPT },
    // A refusal is a reason, always. It counts against the partner's record
    // and the operator has to be able to read why.
    {
      to: 'AWAITING_ASSIGNMENT',
      actors: ['PARTNER', 'UBOSS_ADMIN', 'SYSTEM'],
      permission: ACCEPT,
      requiresReason: true,
    },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  ACCEPTED: [
    { to: 'PICKUP_SCHEDULED', actors: CARRIER_STAFF, permission: PICKUP_WRITE },
    { to: 'ADDRESS_ISSUE', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  PICKUP_SCHEDULED: [
    { to: 'READY_FOR_PICKUP', actors: CARRIER_STAFF, permission: PICKUP_WRITE },
    // Straight to collected, for the carrier whose driver simply turned up.
    // Real operations skip the readiness handshake constantly and a matrix
    // that refuses to model that is a matrix people work around.
    {
      to: 'PICKED_UP',
      actors: [...ANYONE_IN_THE_FIELD, 'SELLER'],
      permission: PICKUP_WRITE,
    },
    // A hand-made booking given up before the carrier came.
    { to: 'AWAITING_ASSIGNMENT', actors: ['SELLER'], requiresReason: true },
    { to: 'DELAYED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ADDRESS_ISSUE', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  READY_FOR_PICKUP: [
    { to: 'PICKED_UP', actors: ANYONE_IN_THE_FIELD, permission: PICKUP_WRITE },
    { to: 'DELAYED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ADDRESS_ISSUE', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  /*
   * In the carrier's hands. From here on the marketplace can no longer cancel
   * the shipment - it can only ask for it back, which is the return workflow.
   */
  PICKED_UP: [
    { to: 'DISPATCHED', actors: CARRIER_STAFF, permission: DISPATCH_WRITE },
    { to: 'AT_ORIGIN_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'IN_TRANSIT', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    ...IN_MOTION_EXCEPTIONS,
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  DISPATCHED: [
    { to: 'AT_ORIGIN_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'CUSTOMS_HOLD', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  AT_ORIGIN_HUB: [
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'CUSTOMS_HOLD', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  IN_TRANSIT: [
    { to: 'AT_DESTINATION_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'OUT_FOR_DELIVERY', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    { to: 'CUSTOMS_HOLD', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ADDRESS_ISSUE', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  AT_DESTINATION_HUB: [
    { to: 'OUT_FOR_DELIVERY', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    // A parcel sorted to the wrong hub goes back on the line. Real, and
    // common enough that refusing it would make the timeline lie.
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'CUSTOMS_HOLD', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ADDRESS_ISSUE', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  /*
   * On the van. The only status from which DELIVERED is reachable, along with
   * DELIVERY_ATTEMPTED below.
   */
  OUT_FOR_DELIVERY: [
    {
      to: 'DELIVERED',
      actors: ['PARTNER', 'DRIVER', 'CARRIER', 'UBOSS_ADMIN', 'SELLER'],
      permission: POD_WRITE,
      requiresProofOfDelivery: true,
    },
    {
      to: 'DELIVERY_ATTEMPTED',
      actors: [...ANYONE_IN_THE_FIELD, 'SELLER'],
      permission: STATUS_WRITE,
      requiresReason: true,
    },
    { to: 'ADDRESS_ISSUE', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
  ],

  DELIVERY_ATTEMPTED: [
    {
      to: 'DELIVERED',
      actors: ['PARTNER', 'DRIVER', 'CARRIER', 'UBOSS_ADMIN', 'SELLER'],
      permission: POD_WRITE,
      requiresProofOfDelivery: true,
    },
    // Another go tomorrow.
    { to: 'OUT_FOR_DELIVERY', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    {
      to: 'DELIVERY_FAILED',
      actors: [...CARRIER_STAFF, 'SELLER'],
      permission: STATUS_WRITE,
      requiresReason: true,
    },
    { to: 'ADDRESS_ISSUE', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    ...IN_MOTION_EXCEPTIONS,
  ],

  /*
   * Settled. The one edge out is a return, and a partner cannot take it: a
   * courier who could un-deliver a parcel could erase the evidence that they
   * delivered it to the wrong door. Everything else needs
   * `assertShipmentCorrection`.
   */
  DELIVERED: [
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  // --- Exceptions rejoin the path ---------------------------------------

  DELAYED: [
    { to: 'READY_FOR_PICKUP', actors: CARRIER_STAFF, permission: STATUS_WRITE },
    { to: 'PICKED_UP', actors: ANYONE_IN_THE_FIELD, permission: PICKUP_WRITE },
    { to: 'AT_ORIGIN_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    // SELLER on these two: their own outside carrier caught up.
    { to: 'IN_TRANSIT', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    { to: 'AT_DESTINATION_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'OUT_FOR_DELIVERY', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    { to: 'DELIVERY_ATTEMPTED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DELIVERY_FAILED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CUSTOMS_HOLD', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ADDRESS_ISSUE', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DAMAGED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'LOST', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  ON_HOLD: [
    { to: 'ACCEPTED', actors: CARRIER_STAFF, permission: STATUS_WRITE },
    { to: 'PICKUP_SCHEDULED', actors: CARRIER_STAFF, permission: PICKUP_WRITE },
    { to: 'READY_FOR_PICKUP', actors: CARRIER_STAFF, permission: STATUS_WRITE },
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'AT_DESTINATION_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'OUT_FOR_DELIVERY', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'DELAYED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  ADDRESS_ISSUE: [
    // Corrected, and back on the van.
    { to: 'OUT_FOR_DELIVERY', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'AT_DESTINATION_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'PICKUP_SCHEDULED', actors: CARRIER_STAFF, permission: PICKUP_WRITE },
    { to: 'DELIVERY_FAILED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  CUSTOMS_HOLD: [
    { to: 'IN_TRANSIT', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'AT_DESTINATION_HUB', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE },
    { to: 'DELAYED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DELIVERY_FAILED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'LOST', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  /*
   * Damaged goods do not carry on to a hospital. The only ways out are back,
   * written off, or - where the damage was to the outer packaging only and
   * somebody inspected it - on again.
   */
  DAMAGED: [
    { to: 'IN_TRANSIT', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DELIVERY_FAILED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'LOST', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
  ],

  /*
   * A cold chain broke. On a catalogue of sterile consumables and reagents
   * this is the most serious exception in the list, which is why it has no
   * edge back to OUT_FOR_DELIVERY without a reason: somebody has to write down
   * that they judged the goods still fit.
   */
  TEMPERATURE_EXCEPTION: [
    { to: 'IN_TRANSIT', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'OUT_FOR_DELIVERY', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DAMAGED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DELIVERY_FAILED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'RETURN_REQUESTED', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
  ],

  DELIVERY_FAILED: [
    // Re-arranged with the receiver.
    { to: 'OUT_FOR_DELIVERY', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    {
      to: 'RETURN_REQUESTED',
      actors: [...CARRIER_STAFF, 'SELLER'],
      permission: STATUS_WRITE,
      requiresReason: true,
    },
    { to: 'ON_HOLD', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  // --- Returns -----------------------------------------------------------

  RETURN_REQUESTED: [
    { to: 'RETURN_IN_TRANSIT', actors: [...CARRIER_STAFF, 'SELLER'], permission: STATUS_WRITE },
    { to: 'CANCELLED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  RETURN_IN_TRANSIT: [
    { to: 'RETURNED', actors: [...ANYONE_IN_THE_FIELD, 'SELLER'], permission: STATUS_WRITE },
    { to: 'DELAYED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'DAMAGED', actors: ANYONE_IN_THE_FIELD, permission: STATUS_WRITE, requiresReason: true },
    { to: 'LOST', actors: CARRIER_STAFF, permission: STATUS_WRITE, requiresReason: true },
  ],

  RETURNED: [],

  // --- Terminal ----------------------------------------------------------

  LOST: [],

  /*
   * Cancelled accepts no further tracking - with one exception. If the goods
   * were already collected when the order was cancelled, they are in a van
   * somewhere and have to come back. Refusing that edge would leave the parcel
   * untrackable for the whole of its journey home.
   */
  CANCELLED: [
    { to: 'RETURN_REQUESTED', actors: ['UBOSS_ADMIN', 'SYSTEM'], requiresReason: true },
  ],
});

/** Statuses from which no further transition exists. */
export const TERMINAL_SHIPMENT_STATUSES: readonly ShipmentStatusName[] = Object.freeze([
  'RETURNED',
  'LOST',
]);

/**
 * Statuses that mean the parcel is in the carrier's physical possession.
 *
 * Read by the inventory integration: stock is committed to fulfilment when a
 * shipment enters this set and released when it leaves it for a return. It is
 * named here rather than computed at the call site so that adding a status
 * cannot silently change what stock does.
 */
export const IN_CARRIER_POSSESSION_STATUSES: readonly ShipmentStatusName[] = Object.freeze([
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
]);

/**
 * Statuses that are an exception the operations queue should be working.
 *
 * Distinct from "not on the happy path": DELIVERY_ATTEMPTED is a normal event
 * on a first attempt and only becomes an exception once the SLA is at risk,
 * which is a different question, answered by the SLA calculator.
 */
export const EXCEPTION_SHIPMENT_STATUSES: readonly ShipmentStatusName[] = Object.freeze([
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'LOST',
]);

/** Statuses after which nothing more will be heard from a carrier feed. */
export const TRACKING_COMPLETE_STATUSES: readonly ShipmentStatusName[] = Object.freeze([
  'DELIVERED',
  'RETURNED',
  'LOST',
  'CANCELLED',
]);

export interface ShipmentTransitionRequest {
  from: ShipmentStatusName;
  to: ShipmentStatusName;
  actor: ShipmentActor;
  /** Logistics permissions the actor holds. Ignored for SYSTEM and CARRIER. */
  permissions?: readonly LogisticsPermissionKey[];
  reason?: string;
  /** Whether a Proof of Delivery exists or accompanies this call. */
  hasProofOfDelivery?: boolean;
}

export interface AllowedShipmentTransition {
  to: ShipmentStatusName;
  requiresReason: boolean;
  requiresProofOfDelivery: boolean;
  permission: LogisticsPermissionKey | null;
}

/**
 * What this actor may do with a shipment in this status.
 *
 * The portal renders exactly these as the options in the Update Status form,
 * which is why the shape is returned rather than a bare list: the form needs
 * to know upfront whether to demand a reason and whether to open the Proof of
 * Delivery panel.
 */
export function allowedShipmentTransitions(
  from: ShipmentStatusName,
  actor: ShipmentActor,
  permissions: readonly LogisticsPermissionKey[] = [],
): AllowedShipmentTransition[] {
  const rules = SHIPMENT_TRANSITIONS[from];
  const held = new Set(permissions);

  return rules
    .filter((rule) => {
      if (!rule.actors.includes(actor)) return false;
      if ((actor === 'PARTNER' || actor === 'DRIVER') && rule.permission !== undefined) {
        return held.has(rule.permission);
      }
      return true;
    })
    .map((rule) => ({
      to: rule.to,
      requiresReason: rule.requiresReason === true,
      requiresProofOfDelivery: rule.requiresProofOfDelivery === true,
      permission: rule.permission ?? null,
    }));
}

export function canTransitionShipment(request: ShipmentTransitionRequest): boolean {
  return allowedShipmentTransitions(request.from, request.actor, request.permissions ?? []).some(
    (allowed) => allowed.to === request.to,
  );
}

/**
 * Throws unless the transition is legal for this actor. Call inside the same
 * transaction that writes the event and the status.
 *
 * `from === to` is a conflict rather than a no-op, deliberately. A carrier
 * feed that reports IN_TRANSIT four times a day is normal and is filtered by
 * the idempotency key before it reaches here; a PERSON pressing "mark in
 * transit" on a shipment that is already in transit has misread the screen,
 * and telling them so is more useful than silently writing a second event.
 */
export function assertShipmentTransition(request: ShipmentTransitionRequest): void {
  const { from, to, actor, reason } = request;

  if (from === to) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      `This shipment is already ${to}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rules = SHIPMENT_TRANSITIONS[from];
  const rule = rules.find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      `A shipment cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      `${describeActor(actor)} cannot move a shipment from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if ((actor === 'PARTNER' || actor === 'DRIVER') && rule.permission !== undefined) {
    const held = request.permissions ?? [];
    if (!held.includes(rule.permission)) {
      throw conflict(
        ErrorCode.PERMISSION_DENIED,
        `This action requires the ${rule.permission} permission.`,
        [{ code: 'PERMISSION_REQUIRED', meta: { permission: rule.permission } }],
      );
    }
  }

  if (rule.requiresReason === true && (reason === undefined || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      `Moving a shipment to ${to} requires a reason.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }

  if (rule.requiresProofOfDelivery === true && request.hasProofOfDelivery !== true) {
    throw conflict(
      ErrorCode.SHIPMENT_POD_REQUIRED,
      'Proof of Delivery is required before a shipment can be marked delivered.',
      [{ code: 'POD_REQUIRED', meta: { from, to } }],
    );
  }
}

/**
 * The operator's correction path.
 *
 * Deliberately NOT a transition. A correction is the marketplace saying "the
 * record is wrong", which is a different act from a parcel moving, and it is
 * the only way out of DELIVERED, RETURNED, LOST or CANCELLED in the wrong
 * direction. It exists because the alternative - an operator with no way to fix
 * a mis-scan - produces a support process that edits the database by hand.
 *
 * Three conditions, all enforced here:
 *   - the actor is the marketplace's own staff, never a partner;
 *   - a reason is mandatory and is written into the event and the audit log;
 *   - the target is a real status, so a correction cannot invent one.
 *
 * The caller writes the resulting event with `isCorrection: true` and
 * `source: 'UBOSS_ADMIN'`, which is what makes a corrected timeline legible
 * months later.
 */
export function assertShipmentCorrection(request: {
  from: ShipmentStatusName;
  to: ShipmentStatusName;
  actor: ShipmentActor;
  reason?: string;
}): void {
  if (request.actor !== 'UBOSS_ADMIN') {
    throw conflict(
      ErrorCode.SHIPMENT_CORRECTION_NOT_ALLOWED,
      'Only the marketplace can correct a shipment status.',
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { actor: request.actor } }],
    );
  }

  if (request.from === request.to) {
    throw conflict(
      ErrorCode.SHIPMENT_CORRECTION_NOT_ALLOWED,
      `This shipment is already ${request.to}.`,
      [{ code: 'SAME_STATUS', meta: { from: request.from, to: request.to } }],
    );
  }

  if (request.reason === undefined || request.reason.trim().length < 8) {
    throw conflict(
      ErrorCode.SHIPMENT_CORRECTION_NOT_ALLOWED,
      'A status correction needs a written reason of at least eight characters.',
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }
}

export function isShipmentStatus(value: string): value is ShipmentStatusName {
  return (ShipmentStatusValues as readonly string[]).includes(value);
}

export function isTerminalShipmentStatus(status: ShipmentStatusName): boolean {
  return TERMINAL_SHIPMENT_STATUSES.includes(status);
}

export function isShipmentException(status: ShipmentStatusName): boolean {
  return EXCEPTION_SHIPMENT_STATUSES.includes(status);
}

export function isTrackingComplete(status: ShipmentStatusName): boolean {
  return TRACKING_COMPLETE_STATUSES.includes(status);
}

/** "A partner" / "the system" - the article has to match the word. */
function describeActor(actor: ShipmentActor): string {
  switch (actor) {
    case 'PARTNER':
      return 'A logistics partner';
    case 'DRIVER':
      return 'A driver';
    case 'CARRIER':
      return 'A carrier feed';
    case 'UBOSS_ADMIN':
      return 'An administrator';
    case 'SYSTEM':
      return 'The system';
    case 'SELLER':
      return 'A seller';
  }
}
