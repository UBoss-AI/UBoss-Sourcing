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
import { LogisticsPermission } from '../../domain/logistics-permissions.js';
import { contactPhoneFor, maskPersonName } from '../../domain/logistics-masking.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordLogisticsAudit } from './audit.service.js';
import { assertDriverBelongsToPartner, assertVehicleBelongsToPartner } from './operations.service.js';
import { assertShipmentAccess } from './shipment.service.js';
import {
  assertLogisticsPermission,
  type LogisticsMembership,
} from './partner.service.js';

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

export interface DriverRow {
  id: string;
  partnerUserId: string;
  fullName: string;
  state: LogisticsDriverState;
  employeeReference: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: Date | null;
  canCarryDangerousGoods: boolean;
  canCarryColdChain: boolean;
  canCarrySterile: boolean;
  hasLocationConsent: boolean;
  openTasks: number;
}

export async function listDrivers(membership: LogisticsMembership): Promise<DriverRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.DRIVER_READ);

  const rows = await prisma.logisticsDriverProfile.findMany({
    where: { logisticsPartnerId: membership.logisticsPartnerId },
    orderBy: [{ state: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      partnerUserId: true,
      state: true,
      employeeReference: true,
      licenceNumber: true,
      licenceExpiresAt: true,
      canCarryDangerousGoods: true,
      canCarryColdChain: true,
      canCarrySterile: true,
      locationConsentAt: true,
      locationConsentWithdrawnAt: true,
      partnerUser: { select: { fullName: true } },
      assignments: { where: { unassignedAt: null, completedAt: null }, select: { id: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    partnerUserId: row.partnerUserId,
    fullName: row.partnerUser.fullName,
    state: row.state,
    employeeReference: row.employeeReference,
    licenceNumber: row.licenceNumber,
    licenceExpiresAt: row.licenceExpiresAt,
    canCarryDangerousGoods: row.canCarryDangerousGoods,
    canCarryColdChain: row.canCarryColdChain,
    canCarrySterile: row.canCarrySterile,
    // Consent given AND not withdrawn. Two columns because withdrawing is not
    // the same as never having given it, and the difference matters to a
    // supervisory authority.
    hasLocationConsent:
      row.locationConsentAt !== null && row.locationConsentWithdrawnAt === null,
    openTasks: row.assignments.length,
  }));
}

export interface UpsertDriverInput {
  partnerUserId: string;
  employeeReference?: string | null;
  licenceNumber?: string | null;
  licenceExpiresAt?: Date | null;
  canCarryDangerousGoods?: boolean;
  canCarryColdChain?: boolean;
  canCarrySterile?: boolean;
  state?: LogisticsDriverState;
}

/**
 * Make somebody a driver, or change their details.
 *
 * The profile hangs off `LogisticsPartnerUser`, so a driver is by construction
 * a member of exactly one carrier and cannot be looked up across tenants. The
 * member must already exist and already hold the DRIVER role - creating a
 * driver profile for a dispatcher would give a person a task list their
 * permissions cannot open.
 */
export async function upsertDriver(
  membership: LogisticsMembership,
  input: UpsertDriverInput,
  correlationId?: string | null,
): Promise<DriverRow> {
  assertLogisticsPermission(membership, LogisticsPermission.DRIVER_WRITE);

  const member = await prisma.logisticsPartnerUser.findFirst({
    where: { id: input.partnerUserId, logisticsPartnerId: membership.logisticsPartnerId },
    select: { id: true, role: true, fullName: true, driverProfile: { select: { id: true } } },
  });

  if (member === null) throw notFound('Member');

  if (member.role !== 'DRIVER') {
    throw conflict(
      ErrorCode.LOGISTICS_DRIVER_NOT_ELIGIBLE,
      `${member.fullName} is not a driver. Change their role first.`,
    );
  }

  const data = {
    employeeReference: input.employeeReference ?? null,
    licenceNumber: input.licenceNumber ?? null,
    licenceExpiresAt: input.licenceExpiresAt ?? null,
    canCarryDangerousGoods: input.canCarryDangerousGoods ?? false,
    canCarryColdChain: input.canCarryColdChain ?? false,
    canCarrySterile: input.canCarrySterile ?? false,
    ...(input.state !== undefined ? { state: input.state } : {}),
  };

  if (member.driverProfile === null) {
    await prisma.logisticsDriverProfile.create({
      data: {
        id: newId(),
        logisticsPartnerId: membership.logisticsPartnerId,
        partnerUserId: member.id,
        ...data,
      },
    });
  } else {
    await prisma.logisticsDriverProfile.update({
      where: { id: member.driverProfile.id },
      data,
    });
  }

  await recordLogisticsAudit({
    logisticsPartnerId: membership.logisticsPartnerId,
    actorUserId: membership.userId,
    actorLabel: membership.fullName,
    action: 'logistics.driver.updated',
    resourceType: 'logistics_driver_profile',
    resourceId: member.driverProfile?.id ?? member.id,
    after: data,
    summary: `${member.fullName}'s driver record was updated.`,
    correlationId: correlationId ?? null,
  });

  const drivers = await listDrivers(membership);
  const updated = drivers.find((row) => row.partnerUserId === member.id);
  if (updated === undefined) throw notFound('Driver');
  return updated;
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

export async function listVehicles(membership: LogisticsMembership): Promise<VehicleRow[]> {
  assertLogisticsPermission(membership, LogisticsPermission.VEHICLE_READ);

  const rows = await prisma.logisticsVehicle.findMany({
    where: { logisticsPartnerId: membership.logisticsPartnerId },
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
  membership: LogisticsMembership,
  input: {
    registration: string;
    kind: LogisticsVehicleKind;
    hasRefrigeration?: boolean;
    hasTailLift?: boolean;
    temperatureMinC?: number | null;
    temperatureMaxC?: number | null;
    maxWeightGrams?: number | null;
  },
): Promise<VehicleRow> {
  assertLogisticsPermission(membership, LogisticsPermission.VEHICLE_WRITE);

  const registration = input.registration.trim().toUpperCase();

  const existing = await prisma.logisticsVehicle.findFirst({
    where: { logisticsPartnerId: membership.logisticsPartnerId, registration },
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
      logisticsPartnerId: membership.logisticsPartnerId,
      registration,
      kind: input.kind,
      hasRefrigeration: input.hasRefrigeration ?? false,
      hasTailLift: input.hasTailLift ?? false,
      temperatureMinC: input.temperatureMinC ?? null,
      temperatureMaxC: input.temperatureMaxC ?? null,
      maxWeightGrams: input.maxWeightGrams ?? null,
    },
  });

  const vehicles = await listVehicles(membership);
  const created = vehicles.find((row) => row.id === id);
  if (created === undefined) throw notFound('Vehicle');
  return created;
}

// ---------------------------------------------------------------------------
// Putting a driver on a consignment
// ---------------------------------------------------------------------------

/**
 * Assign a driver to a stop.
 *
 * Checks the driver's own certifications against the consignment's handling
 * requirements. A driver without a dangerous-goods certificate cannot be put
 * on a dangerous-goods consignment however short-staffed the depot is - that
 * refusal is the whole reason those columns exist rather than being a note in
 * somebody's spreadsheet.
 */
export async function assignDriver(
  membership: LogisticsMembership,
  input: {
    shipmentId: string;
    driverProfileId: string;
    vehicleId?: string | null;
    isPickupLeg?: boolean;
    isDeliveryLeg?: boolean;
    routeSequence?: number | null;
  },
  correlationId?: string | null,
): Promise<{ assignmentId: string }> {
  assertLogisticsPermission(membership, LogisticsPermission.DRIVER_ASSIGN);

  const access = await assertShipmentAccess(membership, input.shipmentId, 'WRITE');
  await assertDriverBelongsToPartner(membership, input.driverProfileId);

  if ((input.vehicleId !== undefined && input.vehicleId !== null)) {
    await assertVehicleBelongsToPartner(membership, input.vehicleId);
  }

  const [shipment, driver] = await Promise.all([
    prisma.logisticsShipment.findUniqueOrThrow({
      where: { id: access.shipmentId },
      select: {
        shipmentReference: true,
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
        partnerUser: { select: { fullName: true } },
      },
    }),
  ]);

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
      `${driver.partnerUser.fullName} is not cleared for ${missing.join(', ')} on this shipment.`,
      [{ code: 'MISSING_CERTIFICATION', meta: { missing: missing.join(',') } }],
    );
  }

  const assignmentId = newId();

  await prisma.$transaction(async (tx) => {
    // One live driver per consignment. The previous one is unassigned rather
    // than deleted, so the record of who had it yesterday survives.
    await tx.logisticsDriverAssignment.updateMany({
      where: { shipmentId: access.shipmentId, unassignedAt: null },
      data: { unassignedAt: new Date() },
    });

    await tx.logisticsDriverAssignment.create({
      data: {
        id: assignmentId,
        shipmentId: access.shipmentId,
        driverProfileId: input.driverProfileId,
        vehicleId: input.vehicleId ?? null,
        isPickupLeg: input.isPickupLeg ?? false,
        isDeliveryLeg: input.isDeliveryLeg ?? true,
        routeSequence: input.routeSequence ?? null,
        assignedByPartnerUserId: membership.partnerUserId,
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.driver.assigned',
        resourceType: 'logistics_driver_assignment',
        resourceId: assignmentId,
        after: { shipmentId: access.shipmentId, driverProfileId: input.driverProfileId },
        summary: `${driver.partnerUser.fullName} was put on ${shipment.shipmentReference}.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  return { assignmentId };
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
