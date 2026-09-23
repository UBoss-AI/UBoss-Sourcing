/**
 * Drivers, vehicles, and one person's day.
 *
 * THE RULE THAT SHAPES THIS FILE
 *
 * A driver holds no permission that can list shipments. Their only path to a
 * consignment is a `LogisticsDriverAssignment` naming them, and every query
 * here starts from their own driver profile rather than from the carrier's
 * shipment table. That is what makes "a driver cannot see another driver's
 * stops" a property of the query rather than a filter somebody remembered to
 * add.
 *
 * The task list is deliberately small: today's work, in route order, with
 * exactly the actions a person standing beside a van can take. A driver app
 * that shows the whole depot's work is an app that leaks the delivery address
 * of every hospital the carrier serves to anybody who borrows a handset.
 */
import type { LogisticsDriverState, LogisticsVehicleKind } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  LogisticsPermission,
  type LogisticsPermissionKey,
} from '../../domain/logistics-permissions.js';
import { contactPhoneFor, maskPersonName } from '../../domain/logistics-masking.js';
import {
  isTrackingComplete,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { OPERATOR_LABEL, recordLogisticsAudit } from './audit.service.js';
import {
  createLogisticsNotification,
  driverNeededKey,
  resolveLogisticsNotifications,
} from './notification.service.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

/**
 * Who is working on a fleet, and on whose behalf.
 *
 * TWO SIDES, ONE IMPLEMENTATION
 *
 * A carrier runs its own fleet from the portal, and the marketplace's own
 * operations desk runs the same fleet from the console - a carrier who has
 * gone quiet still has parcels on vans, and somebody here has to be able to
 * put a driver on one. Rather than a second set of functions that would drift
 * from these, every function in this file takes an actor and resolves it once.
 *
 * The two differ in exactly two ways, and nothing else:
 *
 *   - **How authority is proved.** A carrier's own permissions are checked per
 *     action; an operator has already been through `requireAdmin` with the
 *     logistics grant the route named, so there is nothing further to check.
 *   - **What gets written in `assignedByPartnerUserId`.** An operator is not a
 *     member of the carrier and has no row in that table, so it stays null and
 *     the LABEL is what makes the history readable.
 */
export type FleetActor =
  | { kind: 'PARTNER'; membership: LogisticsMembership }
  | {
      kind: 'OPERATOR';
      logisticsPartnerId: string;
      /** The operator's `users.id`, for the audit trail. */
      userId: string;
      /** How they are named in the carrier's own audit log. */
      label: string;
    };

/** The carrier working on its own fleet. */
export function asPartner(membership: LogisticsMembership): FleetActor {
  return { kind: 'PARTNER', membership };
}

/**
 * The marketplace working on a carrier's fleet.
 *
 * `label` is what appears in the CARRIER's own audit log, so it names the
 * marketplace rather than the individual: a carrier reading their trail should
 * see that the operator did this, not the name of a member of somebody else's
 * staff. The individual is recorded in the operator's own `AuditLog`, which
 * the carrier cannot read - the same split `SellerAuditLog` draws.
 */
export function asOperator(input: {
  logisticsPartnerId: string;
  userId: string;
  label?: string;
}): FleetActor {
  return {
    kind: 'OPERATOR',
    logisticsPartnerId: input.logisticsPartnerId,
    userId: input.userId,
    label: input.label ?? OPERATOR_LABEL,
  };
}

interface ResolvedActor {
  logisticsPartnerId: string;
  userId: string | null;
  label: string;
  /** Null for an operator: they are not a member of this carrier. */
  partnerUserId: string | null;
  isOperator: boolean;
}

function resolveActor(actor: FleetActor, permission: LogisticsPermissionKey): ResolvedActor {
  if (actor.kind === 'OPERATOR') {
    return {
      logisticsPartnerId: actor.logisticsPartnerId,
      userId: actor.userId,
      label: actor.label,
      partnerUserId: null,
      isOperator: true,
    };
  }

  assertLogisticsPermission(actor.membership, permission);

  return {
    logisticsPartnerId: actor.membership.logisticsPartnerId,
    userId: actor.membership.userId,
    label: actor.membership.fullName,
    partnerUserId: actor.membership.partnerUserId,
    isOperator: false,
  };
}

export interface DriverRow {
  id: string;
  /** Their account, where they have one. Null for a record-only driver. */
  partnerUserId: string | null;
  fullName: string;
  phone: string | null;
  email: string | null;
  state: LogisticsDriverState;
  employeeReference: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: Date | null;
  canCarryDangerousGoods: boolean;
  canCarryColdChain: boolean;
  canCarrySterile: boolean;
  /**
   * Whether this driver can sign in to the phone app.
   *
   * Carried out plainly rather than left for a reader to infer from a null id,
   * because it decides what a dispatcher can expect: a record-only driver
   * never scans a package, never captures a signature and never appears on a
   * live map, and a screen that did not say so would look broken.
   */
  hasPortalAccess: boolean;
  hasLocationConsent: boolean;
  openTasks: number;
}

/** Everything a driver row needs, selected once so the readers cannot drift. */
const DRIVER_SELECT = {
  id: true,
  partnerUserId: true,
  fullName: true,
  phone: true,
  email: true,
  state: true,
  employeeReference: true,
  licenceNumber: true,
  licenceExpiresAt: true,
  canCarryDangerousGoods: true,
  canCarryColdChain: true,
  canCarrySterile: true,
  locationConsentAt: true,
  locationConsentWithdrawnAt: true,
  assignments: { where: { unassignedAt: null, completedAt: null }, select: { id: true } },
} as const;

type DriverShape = {
  id: string;
  partnerUserId: string | null;
  fullName: string;
  phone: string | null;
  email: string | null;
  state: LogisticsDriverState;
  employeeReference: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: Date | null;
  canCarryDangerousGoods: boolean;
  canCarryColdChain: boolean;
  canCarrySterile: boolean;
  locationConsentAt: Date | null;
  locationConsentWithdrawnAt: Date | null;
  assignments: { id: string }[];
};

function toDriverRow(row: DriverShape): DriverRow {
  return {
    id: row.id,
    partnerUserId: row.partnerUserId,
    // From the driver record, never through a login. See the schema note on
    // `fullName` - a carrier employs people who will never open this software.
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    state: row.state,
    employeeReference: row.employeeReference,
    licenceNumber: row.licenceNumber,
    licenceExpiresAt: row.licenceExpiresAt,
    canCarryDangerousGoods: row.canCarryDangerousGoods,
    canCarryColdChain: row.canCarryColdChain,
    canCarrySterile: row.canCarrySterile,
    hasPortalAccess: row.partnerUserId !== null,
    // Consent given AND not withdrawn. Two columns because withdrawing is not
    // the same as never having given it, and the difference matters to a
    // supervisory authority.
    hasLocationConsent:
      row.locationConsentAt !== null && row.locationConsentWithdrawnAt === null,
    openTasks: row.assignments.length,
  };
}

export async function listDrivers(actor: FleetActor): Promise<DriverRow[]> {
  const who = resolveActor(actor, LogisticsPermission.DRIVER_READ);

  const rows = await prisma.logisticsDriverProfile.findMany({
    where: { logisticsPartnerId: who.logisticsPartnerId },
    // On the rota first, then by name. A fleet is read by looking somebody up,
    // which is alphabetical, not by when they were added.
    orderBy: [{ state: 'asc' }, { fullName: 'asc' }],
    select: DRIVER_SELECT,
  });

  return rows.map(toDriverRow);
}

export interface DriverDetailsInput {
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  employeeReference?: string | null;
  licenceNumber?: string | null;
  licenceExpiresAt?: Date | null;
  canCarryDangerousGoods?: boolean;
  canCarryColdChain?: boolean;
  canCarrySterile?: boolean;
  state?: LogisticsDriverState;
  /**
   * The member whose account this driver signs in with, where they have one.
   *
   * Optional, and the ordinary case is that it is absent. Supplying it is how
   * a driver gets the phone app; leaving it out is how a subcontracted van
   * driver gets onto the fleet in ten seconds.
   */
  partnerUserId?: string | null;
}

/**
 * Add somebody to the fleet.
 *
 * **A name is enough.** No account, no invitation, no email round trip - a
 * carrier employs people who will never open this software, and a register
 * that could only hold people with a login is a register that does not
 * describe the fleet.
 *
 * Linking an account is optional and additive: pass `partnerUserId` and this
 * driver can also use the phone app, which is what gates the task list, the
 * scanner, proof of delivery and the trip a location ping needs. Leave it out
 * and they are a name a dispatcher can put on a van.
 */
export async function createDriver(
  actor: FleetActor,
  input: DriverDetailsInput,
  correlationId?: string | null,
): Promise<DriverRow> {
  const who = resolveActor(actor, LogisticsPermission.DRIVER_WRITE);

  const fullName = (input.fullName ?? '').trim();

  if (fullName.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, "Give the driver's name.", [
      { field: 'fullName', code: 'REQUIRED' },
    ]);
  }

  const link = await resolveDriverAccount(who.logisticsPartnerId, input.partnerUserId ?? null);

  const id = newId();

  await prisma.logisticsDriverProfile.create({
    data: {
      id,
      logisticsPartnerId: who.logisticsPartnerId,
      fullName,
      phone: emptyToNull(input.phone),
      email: emptyToNull(input.email),
      partnerUserId: link,
      employeeReference: emptyToNull(input.employeeReference),
      licenceNumber: emptyToNull(input.licenceNumber),
      licenceExpiresAt: input.licenceExpiresAt ?? null,
      canCarryDangerousGoods: input.canCarryDangerousGoods ?? false,
      canCarryColdChain: input.canCarryColdChain ?? false,
      canCarrySterile: input.canCarrySterile ?? false,
      state: input.state ?? 'ACTIVE',
    },
  });

  await recordLogisticsAudit({
    logisticsPartnerId: who.logisticsPartnerId,
    actorUserId: who.userId,
    actorLabel: who.label,
    action: 'logistics.driver.added',
    resourceType: 'logistics_driver_profile',
    resourceId: id,
    after: { fullName, hasPortalAccess: link !== null },
    summary: `${fullName} was added to the fleet${who.isOperator ? ' by the marketplace' : ''}.`,
    correlationId: correlationId ?? null,
  });

  return readDriver(who.logisticsPartnerId, id);
}

/**
 * Change a driver's details.
 *
 * Keyed on the DRIVER RECORD rather than on an account, which is the whole
 * point of the change: most drivers have no account to key on. Only the fields
 * supplied are written, so editing a licence number cannot silently clear the
 * certifications beside it - the bug the old whole-record upsert made easy.
 */
export async function updateDriver(
  actor: FleetActor,
  driverProfileId: string,
  input: DriverDetailsInput,
  correlationId?: string | null,
): Promise<DriverRow> {
  const who = resolveActor(actor, LogisticsPermission.DRIVER_WRITE);

  const existing = await prisma.logisticsDriverProfile.findFirst({
    where: { id: driverProfileId, logisticsPartnerId: who.logisticsPartnerId },
    select: { id: true, fullName: true, state: true },
  });

  // The tenant filter is on the query, so another carrier's driver is not
  // found rather than found-and-refused.
  if (existing === null) throw notFound('Driver');

  const fullName = input.fullName === undefined ? undefined : input.fullName.trim();

  if (fullName !== undefined && fullName.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, "Give the driver's name.", [
      { field: 'fullName', code: 'REQUIRED' },
    ]);
  }

  const link =
    input.partnerUserId === undefined
      ? undefined
      : await resolveDriverAccount(who.logisticsPartnerId, input.partnerUserId);

  await prisma.logisticsDriverProfile.update({
    where: { id: existing.id },
    data: {
      ...(fullName === undefined ? {} : { fullName }),
      ...(input.phone === undefined ? {} : { phone: emptyToNull(input.phone) }),
      ...(input.email === undefined ? {} : { email: emptyToNull(input.email) }),
      ...(link === undefined ? {} : { partnerUserId: link }),
      ...(input.employeeReference === undefined
        ? {}
        : { employeeReference: emptyToNull(input.employeeReference) }),
      ...(input.licenceNumber === undefined
        ? {}
        : { licenceNumber: emptyToNull(input.licenceNumber) }),
      ...(input.licenceExpiresAt === undefined
        ? {}
        : { licenceExpiresAt: input.licenceExpiresAt }),
      ...(input.canCarryDangerousGoods === undefined
        ? {}
        : { canCarryDangerousGoods: input.canCarryDangerousGoods }),
      ...(input.canCarryColdChain === undefined
        ? {}
        : { canCarryColdChain: input.canCarryColdChain }),
      ...(input.canCarrySterile === undefined ? {} : { canCarrySterile: input.canCarrySterile }),
      ...(input.state === undefined ? {} : { state: input.state }),
    },
  });

  await recordLogisticsAudit({
    logisticsPartnerId: who.logisticsPartnerId,
    actorUserId: who.userId,
    actorLabel: who.label,
    action:
      input.state !== undefined && input.state !== existing.state
        ? 'logistics.driver.state_changed'
        : 'logistics.driver.updated',
    resourceType: 'logistics_driver_profile',
    resourceId: existing.id,
    before: { fullName: existing.fullName, state: existing.state },
    after: { ...(fullName === undefined ? {} : { fullName }), ...(input.state === undefined ? {} : { state: input.state }) },
    summary: `${fullName ?? existing.fullName}'s driver record was updated${who.isOperator ? ' by the marketplace' : ''}.`,
    correlationId: correlationId ?? null,
  });

  return readDriver(who.logisticsPartnerId, existing.id);
}

/** Trim, and treat "" as "not recorded" rather than as an empty string. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Check that an account being linked belongs to THIS carrier.
 *
 * Without it, a carrier could hand its driver record an account id belonging
 * to somebody at another carrier and give that person a task list full of
 * consignments they have nothing to do with.
 */
async function resolveDriverAccount(
  logisticsPartnerId: string,
  partnerUserId: string | null,
): Promise<string | null> {
  if (partnerUserId === null) return null;

  const member = await prisma.logisticsPartnerUser.findFirst({
    where: { id: partnerUserId, logisticsPartnerId },
    select: { id: true, fullName: true, driverProfile: { select: { id: true } } },
  });

  if (member === null) throw notFound('Member');

  // One account, one driver record. The unique index would refuse this anyway;
  // saying so here makes the refusal a sentence rather than a constraint name.
  if (member.driverProfile !== null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      `${member.fullName} already has a driver record.`,
    );
  }

  return member.id;
}

async function readDriver(logisticsPartnerId: string, id: string): Promise<DriverRow> {
  const row = await prisma.logisticsDriverProfile.findFirst({
    where: { id, logisticsPartnerId },
    select: DRIVER_SELECT,
  });

  if (row === null) throw notFound('Driver');
  return toDriverRow(row);
}

export interface VehicleRow {
  id: string;
  registration: string;
  kind: LogisticsVehicleKind;
  hasRefrigeration: boolean;
  hasTailLift: boolean;
  temperatureMinC: string | null;
  temperatureMaxC: string | null;
  maxWeightGrams: number | null;
  isActive: boolean;
}

export async function listVehicles(actor: FleetActor): Promise<VehicleRow[]> {
  const who = resolveActor(actor, LogisticsPermission.VEHICLE_READ);

  const rows = await prisma.logisticsVehicle.findMany({
    where: { logisticsPartnerId: who.logisticsPartnerId },
    orderBy: [{ isActive: 'desc' }, { registration: 'asc' }],
    select: {
      id: true,
      registration: true,
      kind: true,
      hasRefrigeration: true,
      hasTailLift: true,
      temperatureMinC: true,
      temperatureMaxC: true,
      maxWeightGrams: true,
      isActive: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    temperatureMinC: row.temperatureMinC === null ? null : row.temperatureMinC.toString(),
    temperatureMaxC: row.temperatureMaxC === null ? null : row.temperatureMaxC.toString(),
  }));
}

export async function createVehicle(
  actor: FleetActor,
  input: {
    registration: string;
    kind: LogisticsVehicleKind;
    hasRefrigeration?: boolean;
    hasTailLift?: boolean;
    temperatureMinC?: number | null;
    temperatureMaxC?: number | null;
    maxWeightGrams?: number | null;
  },
  correlationId?: string | null,
): Promise<VehicleRow> {
  const who = resolveActor(actor, LogisticsPermission.VEHICLE_WRITE);

  const registration = input.registration.trim().toUpperCase();

  if (registration.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the vehicle a registration.', [
      { field: 'registration', code: 'REQUIRED' },
    ]);
  }

  const existing = await prisma.logisticsVehicle.findFirst({
    where: { logisticsPartnerId: who.logisticsPartnerId, registration },
    select: { id: true },
  });

  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, 'That vehicle is already on your fleet list.', [
      { field: 'registration', code: 'ALREADY_EXISTS' },
    ]);
  }

  const id = newId();

  await prisma.logisticsVehicle.create({
    data: {
      id,
      logisticsPartnerId: who.logisticsPartnerId,
      registration,
      kind: input.kind,
      hasRefrigeration: input.hasRefrigeration ?? false,
      hasTailLift: input.hasTailLift ?? false,
      temperatureMinC: input.temperatureMinC ?? null,
      temperatureMaxC: input.temperatureMaxC ?? null,
      maxWeightGrams: input.maxWeightGrams ?? null,
    },
  });

  await recordLogisticsAudit({
    logisticsPartnerId: who.logisticsPartnerId,
    actorUserId: who.userId,
    actorLabel: who.label,
    action: 'logistics.vehicle.added',
    resourceType: 'logistics_vehicle',
    resourceId: id,
    after: { registration, kind: input.kind },
    summary: `${registration} was added to the fleet${who.isOperator ? ' by the marketplace' : ''}.`,
    correlationId: correlationId ?? null,
  });

  const vehicles = await listVehicles(actor);
  const created = vehicles.find((row) => row.id === id);
  if (created === undefined) throw notFound('Vehicle');
  return created;
}

// ---------------------------------------------------------------------------
// Putting a driver on a consignment
// ---------------------------------------------------------------------------

/**
 * The consignment, and the right to write to it.
 *
 * The two sides prove that differently and it cannot be collapsed:
 *
 *   - A **carrier** goes through `assertShipmentAccess`, which filters on a
 *     live assignment to their own organisation. A consignment that is not
 *     theirs is not found, and one whose assignment has settled is read-only.
 *   - An **operator** has authority over every consignment on the marketplace
 *     - that is what `logistics.assign` on the route means - so the only thing
 *     left to check is that the consignment is on the carrier whose fleet is
 *     being used. Putting DHL's driver on a DPD consignment is not an
 *     authority question, it is a nonsense.
 */
async function assertFleetShipmentAccess(
  actor: FleetActor,
  who: ResolvedActor,
  shipmentId: string,
): Promise<{ shipmentId: string }> {
  if (actor.kind === 'PARTNER') {
    return assertShipmentAccess(actor.membership, shipmentId, 'WRITE');
  }

  const shipment = await prisma.logisticsShipment.findFirst({
    where: { id: shipmentId, assignedPartnerId: who.logisticsPartnerId },
    select: { id: true },
  });

  if (shipment === null) {
    throw conflict(
      ErrorCode.SHIPMENT_NOT_ASSIGNED,
      'That consignment is not with this carrier, so its drivers cannot be put on it.',
    );
  }

  return { shipmentId: shipment.id };
}

/**
 * This driver, on this fleet, and on the rota.
 *
 * Partner id rather than a membership, so both sides reach the same check.
 * State and tenancy in one query, deliberately: a foreign driver and a
 * stood-down one answer identically, and distinguishing them would confirm
 * that the other carrier's driver exists.
 */
async function assertDriverOnFleet(
  logisticsPartnerId: string,
  driverProfileId: string,
): Promise<void> {
  const driver = await prisma.logisticsDriverProfile.findFirst({
    where: { id: driverProfileId, logisticsPartnerId, state: 'ACTIVE' },
    select: { id: true },
  });

  if (driver === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'That driver is not on this carrier’s active list.',
    );
  }
}

/** The same, for a van. An inactive vehicle is off the road. */
async function assertVehicleOnFleet(
  logisticsPartnerId: string,
  vehicleId: string,
): Promise<void> {
  const vehicle = await prisma.logisticsVehicle.findFirst({
    where: { id: vehicleId, logisticsPartnerId, isActive: true },
    select: { id: true },
  });

  if (vehicle === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'That vehicle is not on this carrier’s active fleet.',
      [{ field: 'vehicleId', code: 'NOT_AVAILABLE' }],
    );
  }
}

/**
 * Assign a driver to a stop, or move it from one driver to another.
 *
 * FOUR REFUSALS, ALL ON THE SERVER
 *
 *   1. **The driver is not this carrier's, or is not ACTIVE.** Handled by
 *      `assertDriverBelongsToPartner`, which filters on both - so a driver id
 *      from another depot and a driver who has been suspended answer the same
 *      way, and neither confirms that the other carrier's driver exists.
 *   2. **The consignment is finished.** Delivered, returned, lost or
 *      cancelled: there is nothing left to carry, and an assignment made after
 *      the fact would put a live stop on somebody's task list for a parcel
 *      that is already in a hospital.
 *   3. **The driver is not cleared for the load.** A driver without a
 *      dangerous-goods certificate cannot be put on a dangerous-goods
 *      consignment however short-staffed the depot is - that refusal is the
 *      whole reason those columns exist rather than being a note in somebody's
 *      spreadsheet.
 *   4. **Somebody else got there first.** See below.
 *
 * THE RACE, AND WHY THE DATABASE SETTLES IT
 *
 * Closing the previous assignment and creating a new one inside a transaction
 * is correct and is not sufficient: two dispatchers pressing Assign in the
 * same second both read "nothing live here", both close nothing, and both
 * insert. `uq_logistics_driver_active` over `activeShipmentId` - NULL once an
 * assignment is over, and NULL is distinct in a MariaDB unique index - is what
 * makes the second insert fail instead. The loser is told plainly to look
 * again rather than silently putting one parcel on two vans.
 *
 * REASSIGNMENT IS A LINK, NOT AN OVERWRITE
 *
 * The outgoing assignment is closed with a reason and the incoming one points
 * back at it. A to B to C, each link carrying why it moved, is what an
 * operator reads after a bad delivery - and it is exactly what an overwrite
 * would have thrown away.
 */
export async function assignDriver(
  actor: FleetActor,
  input: {
    shipmentId: string;
    driverProfileId: string;
    vehicleId?: string | null;
    isPickupLeg?: boolean;
    isDeliveryLeg?: boolean;
    routeSequence?: number | null;
    /**
     * Why the previous driver is coming off.
     *
     * Required when there is one to come off, and ignored on a first
     * assignment - there is nothing to explain about putting the first driver
     * on a parcel.
     */
    reason?: string | null;
  },
  correlationId?: string | null,
): Promise<{ assignmentId: string; replacedAssignmentId: string | null }> {
  const who = resolveActor(actor, LogisticsPermission.DRIVER_ASSIGN);

  const access = await assertFleetShipmentAccess(actor, who, input.shipmentId);
  await assertDriverOnFleet(who.logisticsPartnerId, input.driverProfileId);

  if ((input.vehicleId !== undefined && input.vehicleId !== null)) {
    await assertVehicleOnFleet(who.logisticsPartnerId, input.vehicleId);
  }

  const [shipment, driver] = await Promise.all([
    prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: access.shipmentId },
      select: {
        status: true,
        shipmentReference: true,
        receivingCompanyName: true,
        requiresColdChain: true,
        requiresSterileHandling: true,
        isDangerousGoods: true,
      },
    }),
    prisma.logisticsDriverProfile.findUniqueOrThrow({
      where: { id: input.driverProfileId },
      select: {
        canCarryColdChain: true,
        canCarrySterile: true,
        canCarryDangerousGoods: true,
        licenceExpiresAt: true,
        fullName: true,
        partnerUserId: true,
      },
    }),
  ]);

  /*
   * A finished consignment takes no driver.
   *
   * `isTrackingComplete` rather than `isTerminalShipmentStatus`: the latter is
   * RETURNED and LOST only, and a DELIVERED or CANCELLED parcel is just as
   * finished as far as somebody's task list is concerned. Reading the domain's
   * own list rather than spelling four statuses out here is what stops this
   * check drifting away from the state machine.
   */
  if (isTrackingComplete(shipment.status)) {
    throw conflict(
      ErrorCode.SHIPMENT_TRANSITION_NOT_ALLOWED,
      `${shipment.shipmentReference} is ${shipment.status.toLowerCase().replace(/_/g, ' ')}. It cannot be given to a driver.`,
      [{ code: 'SHIPMENT_FINISHED', meta: { status: shipment.status } }],
    );
  }

  const missing: string[] = [];
  if (shipment.requiresColdChain && !driver.canCarryColdChain) missing.push('cold chain');
  if (shipment.requiresSterileHandling && !driver.canCarrySterile) missing.push('sterile handling');
  if (shipment.isDangerousGoods && !driver.canCarryDangerousGoods) missing.push('dangerous goods');

  if (driver.licenceExpiresAt !== null && driver.licenceExpiresAt < new Date()) {
    missing.push('a current licence');
  }

  if (missing.length > 0) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      `${driver.fullName} is not cleared for ${missing.join(', ')} on this shipment.`,
      [{ code: 'MISSING_CERTIFICATION', meta: { missing: missing.join(',') } }],
    );
  }

  const existing = await prisma.logisticsDriverAssignment.findFirst({
    where: { shipmentId: access.shipmentId, unassignedAt: null },
    select: { id: true, driverProfileId: true, driver: { select: { fullName: true } } },
  });

  const reason = (input.reason ?? '').trim();

  if (existing !== null && existing.driverProfileId === input.driverProfileId) {
    // Already theirs. Not an error and not a second row - a dispatcher
    // pressing Assign twice on the same name has changed nothing.
    return { assignmentId: existing.id, replacedAssignmentId: null };
  }

  if (existing !== null && reason.length < 4) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `Say why ${existing.driver.fullName} is coming off this consignment.`,
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }

  const assignmentId = newId();
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      if (existing !== null) {
        /*
         * Closed CONDITIONALLY on still being live.
         *
         * If a concurrent dispatcher already closed it, this matches nothing,
         * the unique index below refuses the insert, and the loser is told to
         * look again - which is the correct outcome. An unconditional update
         * would have quietly taken their driver off and then failed anyway.
         */
        await tx.logisticsDriverAssignment.updateMany({
          where: { id: existing.id, unassignedAt: null },
          data: {
            unassignedAt: now,
            unassignedReason: reason.slice(0, 512),
            // The marker that frees the consignment for the next assignment.
            // Set together with `unassignedAt`, always.
            activeShipmentId: null,
          },
        });
      }

      await tx.logisticsDriverAssignment.create({
        data: {
          id: assignmentId,
          shipmentId: access.shipmentId,
          activeShipmentId: access.shipmentId,
          driverProfileId: input.driverProfileId,
          vehicleId: input.vehicleId ?? null,
          isPickupLeg: input.isPickupLeg ?? false,
          isDeliveryLeg: input.isDeliveryLeg ?? true,
          routeSequence: input.routeSequence ?? null,
          assignedByPartnerUserId: who.partnerUserId,
          assignedByLabel: who.label,
          previousAssignmentId: existing?.id ?? null,
        },
      });

      await recordLogisticsAudit(
        {
          logisticsPartnerId: who.logisticsPartnerId,
          actorUserId: who.userId,
          actorLabel: who.label,
          action: existing === null ? 'logistics.driver.assigned' : 'logistics.driver.reassigned',
          resourceType: 'logistics_driver_assignment',
          resourceId: assignmentId,
          ...(existing === null
            ? {}
            : { before: { driverProfileId: existing.driverProfileId, reason } }),
          after: { shipmentId: access.shipmentId, driverProfileId: input.driverProfileId },
          summary:
            existing === null
              ? `${driver.fullName} was put on ${shipment.shipmentReference}.`
              : `${shipment.shipmentReference} moved from ${existing.driver.fullName} to ${driver.fullName}: ${reason}`,
          correlationId: correlationId ?? null,
        },
        tx,
      );
    });
  } catch (error) {
    if (lostTheAssignmentRace(error)) {
      throw conflict(
        ErrorCode.SHIPMENT_ASSIGNMENT_SETTLED,
        'Somebody else assigned this consignment a moment ago. Reload it and look again.',
      );
    }
    throw error;
  }

  /*
   * Told, outside the transaction.
   *
   * A notification that cannot be written must not roll back an assignment
   * that has already been made - the van is the fact, and the alert is how
   * somebody finds out about it.
   */
  await createLogisticsNotification({
    logisticsPartnerId: who.logisticsPartnerId,
    shipmentId: access.shipmentId,
    kind: existing === null ? 'DRIVER_ASSIGNED' : 'DRIVER_REASSIGNED',
    title:
      existing === null
        ? `${shipment.shipmentReference}: ${driver.fullName} assigned`
        : `${shipment.shipmentReference}: moved to ${driver.fullName}`,
    body: existing === null ? shipment.receivingCompanyName : reason.slice(0, 1000),
    variables: {
      shipmentReference: shipment.shipmentReference,
      driverName: driver.fullName,
      receivingCompany: shipment.receivingCompanyName,
      ...(existing === null ? {} : { previousDriverName: existing.driver.fullName }),
    },
    // Keyed on the assignment, so a reassignment announces itself rather than
    // being swallowed as a duplicate of the one it replaced.
    dedupeKey: `driver-assignment:${assignmentId}`,
  });

  /*
   * And the driver themselves, where they sign in to the portal.
   *
   * The notice above goes to the whole company's feed, which is where a
   * dispatcher works from. The person who has to drive to the pickup door is
   * told separately, addressed to their own sign-in - a delivery they only
   * find by scrolling somebody else's feed is one they find late. A driver
   * with no sign-in is told by their dispatcher, as before.
   */
  // Somebody is driving it now, which is the whole of what that alert asked.
  await resolveLogisticsNotifications({
    resolutionKey: driverNeededKey(access.shipmentId),
    reason: `${driver.fullName} was assigned.`,
    source: 'DOMAIN_EVENT',
  });

  if (driver.partnerUserId !== null) {
    await createLogisticsNotification({
      logisticsPartnerId: who.logisticsPartnerId,
      partnerUserId: driver.partnerUserId,
      shipmentId: access.shipmentId,
      kind: 'DRIVER_ASSIGNED',
      title: `New delivery: ${shipment.shipmentReference}`,
      body: shipment.receivingCompanyName,
      variables: {
        shipmentReference: shipment.shipmentReference,
        receivingCompany: shipment.receivingCompanyName,
      },
      dedupeKey: `driver-task:${assignmentId}`,
    });
  }

  return { assignmentId, replacedAssignmentId: existing?.id ?? null };
}

/**
 * Did this fail because somebody else assigned the consignment first?
 *
 * P2002 on `uq_logistics_driver_active` is the only way that index can be
 * violated, because nothing else writes `activeShipmentId`. Matched on the
 * code rather than on the message, which is provider prose.
 */
function lostTheAssignmentRace(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Take the driver off, without putting another one on.
 *
 * The case a reassignment cannot cover: a driver has called in sick and the
 * depot does not yet know who is taking their round. Leaving them on the
 * consignment would leave a stop on a task list nobody is going to work.
 */
export async function unassignDriver(
  actor: FleetActor,
  shipmentId: string,
  reason: string,
  correlationId?: string | null,
): Promise<{ unassignedAssignmentId: string | null }> {
  const who = resolveActor(actor, LogisticsPermission.DRIVER_ASSIGN);

  const access = await assertFleetShipmentAccess(actor, who, shipmentId);

  const trimmed = reason.trim();
  if (trimmed.length < 4) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Say why the driver is coming off this consignment.',
      [{ field: 'reason', code: 'REASON_REQUIRED' }],
    );
  }

  const existing = await prisma.logisticsDriverAssignment.findFirst({
    where: { shipmentId: access.shipmentId, unassignedAt: null },
    select: {
      id: true,
      driverProfileId: true,
      driver: { select: { fullName: true } },
      shipment: { select: { shipmentReference: true } },
    },
  });

  // Nobody on it is the desired end state, so saying so twice is not an error.
  if (existing === null) return { unassignedAssignmentId: null };

  await prisma.$transaction(async (tx) => {
    await tx.logisticsDriverAssignment.updateMany({
      where: { id: existing.id, unassignedAt: null },
      data: {
        unassignedAt: new Date(),
        unassignedReason: trimmed.slice(0, 512),
        activeShipmentId: null,
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: who.logisticsPartnerId,
        actorUserId: who.userId,
        actorLabel: who.label,
        action: 'logistics.driver.unassigned',
        resourceType: 'logistics_driver_assignment',
        resourceId: existing.id,
        before: { driverProfileId: existing.driverProfileId },
        after: { reason: trimmed },
        summary: `${existing.driver.fullName} came off ${existing.shipment.shipmentReference}: ${trimmed}`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  return { unassignedAssignmentId: existing.id };
}


// ---------------------------------------------------------------------------
// One driver's day
// ---------------------------------------------------------------------------

export interface DriverTask {
  assignmentId: string;
  shipmentId: string;
  shipmentReference: string;
  trackingNumber: string;
  leg: 'PICKUP' | 'DELIVERY';
  routeSequence: number | null;
  status: ShipmentStatusName;

  companyName: string;
  contactName: string | null;
  /** Unmasked: this is the caller's own stop, today. */
  contactPhone: string | null;
  addressLines: string[];
  city: string | null;
  postalCode: string | null;
  countryCode: string;
  latitude: string | null;
  longitude: string | null;

  packageCount: number;
  requiresColdChain: boolean;
  isDangerousGoods: boolean;
  isFragile: boolean;
  handlingNotes: string | null;

  dueAt: Date | null;
  /** What the deployment's policy demands before this can be marked delivered. */
  podPolicy: {
    requiresRecipientName: boolean;
    requiresSignature: boolean;
    requiresPhoto: boolean;
    requiresOtp: boolean;
    requiresDesignation: boolean;
  };
}

/**
 * Today's stops, for the person holding the handset.
 *
 * Starts from the DRIVER PROFILE and never from the carrier's shipment table,
 * which is what makes one driver's list one driver's list. The caller must be
 * that driver: `membership.driverProfileId` is the only id used, and it comes
 * from the session.
 *
 * Contact details are NOT masked here, and that is the one place in this
 * codebase where a full telephone number is returned. The context is
 * `ACTIVE_DELIVERY` and the viewer is the assigned driver - the exact case
 * `revealPolicyFor` unmasks, because the alternative is a courier standing
 * outside a locked loading bay with no way to ring the bell.
 */
export async function readDriverTasks(
  membership: LogisticsMembership,
  options: { horizonHours?: number } = {},
): Promise<DriverTask[]> {
  assertLogisticsPermission(membership, LogisticsPermission.DRIVER_TASK_READ);

  if (membership.driverProfileId === null) {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      'This account has no driver record, so it has no task list.',
    );
  }

  const horizon = new Date(Date.now() + (options.horizonHours ?? 48) * 3_600_000);

  const rows = await prisma.logisticsDriverAssignment.findMany({
    where: {
      driverProfileId: membership.driverProfileId,
      unassignedAt: null,
      completedAt: null,
      shipment: {
        // Finished work drops off the list. A driver scrolling past yesterday's
        // deliveries to find today's is a driver who misses one.
        status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
        OR: [
          { expectedPickupAt: { lte: horizon } },
          { estimatedDeliveryAt: { lte: horizon } },
          { expectedPickupAt: null, estimatedDeliveryAt: null },
        ],
      },
    },
    orderBy: [{ routeSequence: 'asc' }, { assignedAt: 'asc' }],
    take: 200,
    select: {
      id: true,
      isPickupLeg: true,
      routeSequence: true,
      shipment: {
        select: {
          id: true,
          shipmentReference: true,
          trackingNumber: true,
          status: true,
          packageCount: true,
          requiresColdChain: true,
          isDangerousGoods: true,
          isFragile: true,
          handlingNotes: true,
          expectedPickupAt: true,
          estimatedDeliveryAt: true,
          sellerCompanyName: true,
          receivingCompanyName: true,
          pickupAddressJson: true,
          deliveryAddressJson: true,
          pickupContactName: true,
          pickupContactPhone: true,
          deliveryContactName: true,
          deliveryContactPhone: true,
          destinationCity: true,
          destinationPostalCode: true,
          destinationCountry: true,
          originCountry: true,
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
      },
    },
  });

  const viewer = { permissions: membership.permissions, isAssignedDriver: true };

  return rows.map((row) => {
    const isPickup = row.isPickupLeg;
    const shipment = row.shipment;
    const address = readAddress(isPickup ? shipment.pickupAddressJson : shipment.deliveryAddressJson);

    const rawPhone = isPickup ? shipment.pickupContactPhone : shipment.deliveryContactPhone;
    const revealed = contactPhoneFor(rawPhone, viewer, 'ACTIVE_DELIVERY');

    return {
      assignmentId: row.id,
      shipmentId: shipment.id,
      shipmentReference: shipment.shipmentReference,
      trackingNumber: shipment.trackingNumber,
      leg: isPickup ? 'PICKUP' : 'DELIVERY',
      routeSequence: row.routeSequence,
      status: shipment.status,

      companyName: isPickup ? shipment.sellerCompanyName : shipment.receivingCompanyName,
      // A warehouse contact is a business contact and is shown in full; the
      // person at the far door is an individual and is shortened even for the
      // driver, because a given name and an initial is all that is needed to
      // ask for somebody at a reception desk.
      contactName: isPickup
        ? shipment.pickupContactName
        : maskPersonName(shipment.deliveryContactName),
      contactPhone: revealed.display,
      addressLines: address.lines,
      city: isPickup ? address.city : shipment.destinationCity,
      postalCode: isPickup ? address.postalCode : shipment.destinationPostalCode,
      countryCode: isPickup ? shipment.originCountry : shipment.destinationCountry,
      latitude: address.latitude,
      longitude: address.longitude,

      packageCount: shipment.packageCount,
      requiresColdChain: shipment.requiresColdChain,
      isDangerousGoods: shipment.isDangerousGoods,
      isFragile: shipment.isFragile,
      handlingNotes: shipment.handlingNotes,

      dueAt: isPickup ? shipment.expectedPickupAt : shipment.estimatedDeliveryAt,

      podPolicy: {
        requiresRecipientName: shipment.slaPolicy?.podRequiresRecipientName ?? true,
        requiresSignature: shipment.slaPolicy?.podRequiresSignature ?? false,
        requiresPhoto: shipment.slaPolicy?.podRequiresPhoto ?? false,
        requiresOtp: shipment.slaPolicy?.podRequiresOtp ?? false,
        requiresDesignation: shipment.slaPolicy?.podRequiresDesignation ?? false,
      },
    };
  });
}

/**
 * Pull the parts of an address a phone screen can show.
 *
 * Defensive for the same reason `parseAddress` in the creation service is: the
 * column is JSON and what comes back is whatever was written. A missing line
 * produces a shorter list rather than the word "undefined" on a driver's
 * screen at a junction.
 */
function readAddress(value: unknown): {
  lines: string[];
  city: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
} {
  if (typeof value !== 'object' || value === null) {
    return { lines: [], city: null, postalCode: null, latitude: null, longitude: null };
  }

  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && (raw[key]).trim().length > 0
      ? (raw[key]).trim()
      : null;

  const number = (key: string): string | null =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? String(raw[key]) : null;

  return {
    lines: [text('line1'), text('line2'), text('region')].filter(
      (line): line is string => line !== null,
    ),
    city: text('city'),
    postalCode: text('postalCode'),
    latitude: number('latitude'),
    longitude: number('longitude'),
  };
}

/**
 * Find a package by the barcode a driver just scanned.
 *
 * Tenant-scoped through the shipment's assignment, so a scanner pointed at
 * another carrier's label finds nothing rather than telling the driver whose
 * it is. Returns the shipment so the app can open the right stop.
 */
export async function findScannedPackage(
  membership: LogisticsMembership,
  packageReference: string,
): Promise<{ shipmentId: string; shipmentReference: string; packageId: string; sequence: number }> {
  const trimmed = packageReference.trim().toUpperCase();

  if (trimmed.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Scan or type a package reference.', [
      { field: 'packageReference', code: 'REQUIRED' },
    ]);
  }

  const found = await prisma.logisticsShipmentPackage.findFirst({
    where: {
      packageReference: trimmed,
      shipment: {
        assignments: {
          some: { logisticsPartnerId: membership.logisticsPartnerId, state: { in: ['OFFERED', 'ACCEPTED'] } },
        },
      },
    },
    select: {
      id: true,
      sequence: true,
      shipment: { select: { id: true, shipmentReference: true } },
    },
  });

  if (found === null) throw notFound('Package');

  // Belt and braces: the assignment filter above is the tenant boundary, and
  // this re-checks it through the one function that also narrows a driver to
  // their own stops.
  await assertShipmentAccess(membership, found.shipment.id, 'WRITE');

  return {
    shipmentId: found.shipment.id,
    shipmentReference: found.shipment.shipmentReference,
    packageId: found.id,
    sequence: found.sequence,
  };
}

/** Record that a carton went on the van, or came off it. */
export async function recordPackageScan(
  membership: LogisticsMembership,
  packageId: string,
  direction: 'OUT' | 'IN',
): Promise<void> {
  const record = await prisma.logisticsShipmentPackage.findFirst({
    where: {
      id: packageId,
      shipment: {
        assignments: {
          some: { logisticsPartnerId: membership.logisticsPartnerId, state: { in: ['OFFERED', 'ACCEPTED'] } },
        },
      },
    },
    select: { id: true, shipmentId: true, scannedOutAt: true, scannedInAt: true },
  });

  if (record === null) throw notFound('Package');

  await assertShipmentAccess(membership, record.shipmentId, 'WRITE');

  // Written once. A second scan of the same carton is a driver checking, not a
  // second collection, and overwriting the time would lose when it actually
  // went on the van.
  await prisma.logisticsShipmentPackage.updateMany({
    where: {
      id: record.id,
      ...(direction === 'OUT' ? { scannedOutAt: null } : { scannedInAt: null }),
    },
    data: direction === 'OUT' ? { scannedOutAt: new Date() } : { scannedInAt: new Date() },
  });
}
